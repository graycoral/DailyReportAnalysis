package hub

import (
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

const reportBatchMax = 32 << 20
const reportBatchFiles = 256

type markdownFile struct {
	Name string
	Body []byte
}
type markdownResult struct {
	Name    string `json:"name"`
	ID      string `json:"id,omitempty"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

func (a *App) importMarkdownBatch(files []markdownFile) ([]markdownResult, error) {
	companies := a.knownCompanies()
	results := make([]markdownResult, len(files))
	items := make([]importedReport, len(files))
	valid := false
	for i, file := range files {
		results[i] = markdownResult{Name: file.Name, Status: "error"}
		if !strings.EqualFold(filepath.Ext(file.Name), ".md") {
			results[i].Message = ".md 파일을 선택하세요."
			continue
		}
		r, err := parseReport(file.Body, file.Name, companies)
		if err != nil {
			results[i].Message = err.Error()
			if errors.Is(err, errNoUpdates) {
				results[i].Status = "skipped"
			}
			continue
		}
		items[i] = importedReport{Report: r, Hash: bodyHash(r.Body), Origin: "markdown", Imported: time.Now().In(kst).Format(time.RFC3339)}
		valid = true
	}
	if !valid {
		return results, nil
	}
	a.localMu.Lock()
	defer a.localMu.Unlock()
	if err := a.localBlocked(); err != nil {
		return nil, err
	}
	x, err := a.loadReports()
	if err != nil {
		return nil, err
	}
	positions := make(map[string]int, len(x.Reports)+len(items))
	usedIDs := make(map[string]bool, len(x.Reports)+len(items))
	for i, item := range x.Reports {
		positions[item.Origin+"\n"+item.Date] = i
		usedIDs[item.ID] = true
	}
	changed := false
	for i, item := range items {
		if item.ID == "" {
			continue
		}
		status := "added"
		key := item.Origin + "\n" + item.Date
		if at, found := positions[key]; found {
			one := reportArchive{Reports: x.Reports[at : at+1]}
			status = mergeImported(&one, &item)
		} else {
			assignImportedID(&item, func(id string) bool { return usedIDs[id] })
			usedIDs[item.ID] = true
			positions[key] = len(x.Reports)
			x.Reports = append(x.Reports, item)
		}
		changed = changed || status == "added" || status == "updated"
		results[i].ID, results[i].Status = item.ID, status
	}
	if changed {
		err = a.saveReports(x)
	}
	return results, err
}

func (a *App) importMarkdownBatchHandler(w http.ResponseWriter, r *http.Request) {
	if !post(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, reportBatchMax)
	reader, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "MD 파일 묶음을 읽을 수 없습니다.", 400)
		return
	}
	// MultipartReader keeps private report bodies out of temporary disk files.
	files := []markdownFile{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil || len(files) >= reportBatchFiles {
			http.Error(w, "한 묶음은 256개, 32MB 이하여야 합니다.", 413)
			return
		}
		body, err := io.ReadAll(io.LimitReader(part, reportMax+1))
		if err != nil || len(body) > reportMax {
			http.Error(w, "MD 파일은 각각 2MB 이하여야 합니다.", 413)
			return
		}
		files = append(files, markdownFile{Name: part.FileName(), Body: body})
		part.Close()
	}
	results, err := a.importMarkdownBatch(files)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	writeResponse(w, map[string]any{"results": results})
}
