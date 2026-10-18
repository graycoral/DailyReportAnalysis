// Read-only Extended MAPI bridge for embedded messages. Outlook's out-of-process
// Attachment.MAPIOBJECT cannot expose IAttach, so open the selected store/item in
// the same profile. No SaveChanges, SaveAsFile, temporary mail copies or sends.
// Vtable layouts: Microsoft Learn IMAPIProp, IMAPISession, IMsgStore, IMessage,
// IMAPITable. All interfaces are released within the PowerShell bridge process.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class OutlookEmbeddedReader : IDisposable {
    public sealed class File { public string Name; public string Body; }
    public sealed class Result {
        public List<File> Files = new List<File>();
        public int Failed;
        public int Limited;
    }
    const int ReportLimit = 2 * 1024 * 1024;
    IntPtr session;
    bool initialized;
    static readonly Guid MessageID = new Guid("00020307-0000-0000-C000-000000000046");
    static readonly Guid StreamID = new Guid("0000000C-0000-0000-C000-000000000046");
    [DllImport("mapi32.dll")] static extern int MAPIInitialize(IntPtr init);
    [DllImport("mapi32.dll")] static extern void MAPIUninitialize();
    [DllImport("mapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern int MAPILogonEx(IntPtr window, string profile, string password, uint flags, out IntPtr session);
    [DllImport("mapi32.dll")] static extern int MAPIFreeBuffer(IntPtr buffer);
    [DllImport("mapi32.dll")] static extern void FreeProws(IntPtr rows);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OpenStore(IntPtr self, IntPtr window, int count, byte[] id, IntPtr iid, uint flags, out IntPtr store);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OpenEntry(IntPtr self, int count, byte[] id, IntPtr iid, uint flags, out uint type, out IntPtr item);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetProps(IntPtr self, uint[] tags, uint flags, out uint count, out IntPtr values);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OpenProperty(IntPtr self, uint tag, ref Guid iid, uint options, uint flags, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetTable(IntPtr self, uint flags, out IntPtr table);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OpenAttach(IntPtr self, uint number, IntPtr iid, uint flags, out IntPtr attachment);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetColumns(IntPtr self, uint[] tags, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int QueryRows(IntPtr self, int count, uint flags, out IntPtr rows);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int StreamRead(IntPtr self, [Out] byte[] buffer, int count, out int read);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Logoff(IntPtr self, IntPtr window, uint flags, uint reserved);

    static T Method<T>(IntPtr obj, int slot) where T : class {
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size), typeof(T));
    }
    static void Check(int hr, string operation = "MAPI") { if (hr < 0) throw new COMException("Embedded report read: " + operation, hr); }
    static void Release(IntPtr obj) { if (obj != IntPtr.Zero) Marshal.Release(obj); }
    static byte[] Hex(string value) {
        if (String.IsNullOrEmpty(value) || value.Length % 2 != 0 || value.Length > 4096) throw new ArgumentException("Invalid MAPI ID");
        byte[] bytes = new byte[value.Length / 2];
        for (int i = 0; i < bytes.Length; i++) bytes[i] = Convert.ToByte(value.Substring(i * 2, 2), 16);
        return bytes;
    }
    public OutlookEmbeddedReader(string profile) {
        Check(MAPIInitialize(IntPtr.Zero)); initialized = true;
        try {
            // UNICODE | NO_MAIL | EXTENDED | NEW_SESSION, no login dialog.
            Check(MAPILogonEx(IntPtr.Zero, profile, null, 0x80008022, out session));
        } catch { Dispose(); throw; }
    }
    public void Dispose() {
        if (session != IntPtr.Zero) {
            try { Method<Logoff>(session, 17)(session, IntPtr.Zero, 0, 0); }
            finally { Release(session); session = IntPtr.Zero; }
        }
        if (initialized) { MAPIUninitialize(); initialized = false; }
    }
    static object Property(IntPtr obj, uint tag) {
        IntPtr values = IntPtr.Zero; uint count;
        try {
            Check(Method<GetProps>(obj, 5)(obj, new uint[] {1, tag}, 0, out count, out values));
            if (count != 1 || values == IntPtr.Zero || (uint)Marshal.ReadInt32(values) != tag) return null;
            if ((tag & 0xFFFF) == 3) return Marshal.ReadInt32(values, 8);
            if ((tag & 0xFFFF) == 31) return Marshal.PtrToStringUni(Marshal.ReadIntPtr(values, 8));
            return null;
        } finally { if (values != IntPtr.Zero) MAPIFreeBuffer(values); }
    }
    static IntPtr Open(IntPtr obj, uint tag, Guid iid) {
        IntPtr value;
        Check(Method<OpenProperty>(obj, 7)(obj, tag, ref iid, 0, 0, out value), "OpenProperty " + tag.ToString("X8"));
        return value;
    }
    static byte[] StreamBytes(IntPtr obj, uint tag, int limit) {
        IntPtr stream = Open(obj, tag, StreamID);
        try {
            var read = Method<StreamRead>(stream, 3);
            using (var data = new MemoryStream()) {
                byte[] chunk = new byte[16384]; int count;
                do {
                    Check(read(stream, chunk, chunk.Length, out count));
                    if (count < 0 || count > chunk.Length || data.Length + count > limit) throw new InvalidDataException("Embedded report size limit");
                    data.Write(chunk, 0, count);
                } while (count != 0);
                return data.ToArray();
            }
        } finally { Release(stream); }
    }
    sealed class Budget { public int Attachments; public int Bytes; public int Count; }
    public Result Read(string storeID, string entryID, int maximum) {
        if (session == IntPtr.Zero) throw new ObjectDisposedException("OutlookEmbeddedReader");
        var result = new Result();
        if (maximum <= 0) { result.Limited++; return result; }
        IntPtr store = IntPtr.Zero, message = IntPtr.Zero;
        try {
            byte[] sid = Hex(storeID), eid = Hex(entryID); uint type;
            Check(Method<OpenStore>(session, 5)(session, IntPtr.Zero, sid.Length, sid, IntPtr.Zero, 0x81, out store), "OpenStore");
            Check(Method<OpenEntry>(store, 17)(store, eid.Length, eid, IntPtr.Zero, 0, out type, out message), "OpenMessage");
            if (type != 5) throw new InvalidDataException("Expected message");
            // Attachment numbers belong to this table/session, not the Outlook
            // automation session. Keep each native table open while visiting.
            Visit(message, 0, new Budget {Count = Math.Min(maximum, 8)}, result);
        } finally { Release(message); Release(store); }
        return result;
    }
    static void Visit(IntPtr message, int depth, Budget budget, Result result) {
        if (depth >= 4 || budget.Attachments >= 64 || result.Files.Count >= budget.Count) { result.Limited++; return; }
        // Embedded message bodies are not archived. Only explicit .md files are
        // returned for the normal report validator, linked to the outer mail.
        IntPtr table = IntPtr.Zero;
        try {
            Check(Method<GetTable>(message, 14)(message, 0, out table));
            Check(Method<SetColumns>(table, 7)(table, new uint[] {1, 0x0E210003}, 0));
            while (true) {
                IntPtr rows = IntPtr.Zero; int number;
                try {
                    Check(Method<QueryRows>(table, 19)(table, 1, 0, out rows));
                    if (rows == IntPtr.Zero || Marshal.ReadInt32(rows) == 0) break;
                    if (Marshal.ReadInt32(rows) != 1) throw new InvalidDataException("Unexpected attachment rows");
                    IntPtr row = IntPtr.Add(rows, IntPtr.Size);
                    if (Marshal.ReadInt32(row, 4) != 1) throw new InvalidDataException("Unexpected attachment columns");
                    IntPtr prop = Marshal.ReadIntPtr(row, 8);
                    if ((uint)Marshal.ReadInt32(prop) != 0x0E210003) throw new InvalidDataException("Missing attachment number");
                    number = Marshal.ReadInt32(prop, 8);
                } finally { if (rows != IntPtr.Zero) FreeProws(rows); }
                if (++budget.Attachments > 64 || result.Files.Count >= budget.Count) { result.Limited++; break; }
                IntPtr attachment = IntPtr.Zero;
                try {
                    Check(Method<OpenAttach>(message, 15)(message, (uint)number, IntPtr.Zero, 0, out attachment), "OpenAttach");
                    int method = (int)(Property(attachment, 0x37050003) ?? 0);
                    if (method == 5) {
                        IntPtr inner = Open(attachment, 0x3701000D, MessageID);
                        try { Visit(inner, depth + 1, budget, result); } finally { Release(inner); }
                    } else if (method == 1 && depth > 0) {
                        string name = (string)(Property(attachment, 0x3707001F) ?? Property(attachment, 0x3704001F) ?? "");
                        if (!name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) continue;
                        int limit = Math.Min(ReportLimit, 8 * 1024 * 1024 - budget.Bytes);
                        if (limit <= 0) { result.Limited++; break; }
                        byte[] bytes = StreamBytes(attachment, 0x37010102, limit);
                        budget.Bytes += bytes.Length;
                        result.Files.Add(new File {Name = name, Body = new UTF8Encoding(false, true).GetString(bytes)});
                    }
                } catch (InvalidDataException) { result.Limited++; }
                  catch (Exception) { result.Failed++; }
                finally { Release(attachment); }
            }
        } finally { Release(table); }
    }
}
