"""Task lifecycle and concurrency regressions without downloading or loading a model."""
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image

import embed_core as ec
import rag_server as server
from tasks import Jobs, ModelGate


class EfficiencyTests(unittest.TestCase):
    def test_jobs_deduplicate_bound_queue_and_report_errors(self):
        jobs = Jobs(capacity=1)
        release = threading.Event()
        try:
            first = jobs.start('same', lambda progress: (progress(7), release.wait(5), {'pages': 7})[-1])
            second = jobs.start('same', lambda progress: self.fail('duplicate work'))
            self.assertEqual(first['job'], second['job'])
            with self.assertRaises(ValueError):
                jobs.start('another', lambda progress: None)
        finally:
            release.set()
        for _ in range(200):
            value = jobs.get(first['job'])
            if value['state'] == 'done':
                break
            time.sleep(.01)
        self.assertEqual(value['result'], {'pages': 7})
        self.assertEqual(value['pages_done'], 7)
        failed = jobs.start('error', lambda progress: 1 / 0)
        for _ in range(200):
            value = jobs.get(failed['job'])
            if value['state'] == 'error':
                break
            time.sleep(.01)
        self.assertIn('division', value['error'])

    def test_query_runs_before_next_index_page(self):
        gate = ModelGate()
        order = []
        started = threading.Event()
        release = threading.Event()
        def index():
            with gate.use():
                order.append('page1')
                started.set()
                release.wait(5)
            with gate.use():
                order.append('page2')
        def query():
            with gate.use(interactive=True):
                order.append('query')
        index_thread = threading.Thread(target=index)
        query_thread = threading.Thread(target=query)
        index_thread.start()
        self.assertTrue(started.wait(2))
        query_thread.start()
        try:
            for _ in range(200):
                with gate.condition:
                    if gate.waiting_queries:
                        break
                time.sleep(.01)
            self.assertEqual(gate.waiting_queries, 1)
        finally:
            release.set()
            index_thread.join(3)
            query_thread.join(3)
        self.assertEqual(order, ['page1', 'query', 'page2'])

    def test_map_reuses_old_pairs_including_non_matches(self):
        server.state.update(docs={k: {'name': k} for k in 'abc'},
                            vecs={k: np.eye(3, dtype=np.float32)[i:i+1] for i, k in enumerate('abc')},
                            revision=1, map_cache=None, pair_cache={})
        with patch.object(server, 'compare_documents', wraps=server.compare_documents) as compare:
            self.assertEqual(server.map_data()['links'], [])
            self.assertEqual(compare.call_count, 3)
            server.state['docs']['d'] = {'name': 'd'}
            server.state['vecs']['d'] = np.array([[1., 0., 0.]], dtype=np.float32)
            server.state.update(revision=2, map_cache=None)
            self.assertEqual(len(server.map_data()['links']), 1)
            self.assertEqual(compare.call_count, 6, 'only the three new pairs should be computed')
            server.state['docs'].pop('b'); server.state['vecs'].pop('b')
            server.state.update(revision=3, map_cache=None)
            server.map_data()
            self.assertEqual(compare.call_count, 6, 'deletion must not recompute unchanged vectors')
            self.assertTrue(all('b' not in key for key in server.state['pair_cache']))

    def test_demo_reuses_resident_model(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            server.state['model'], server.state['info'] = object(), {'model': 'resident'}
            with patch.object(ec, 'INDEX_DIR', root), patch.object(ec, 'DOCS_DIR', root), \
                 patch.object(ec, 'list_pdfs', return_value=[]), patch.object(ec, 'ensure_sample_pdf', return_value=None), \
                 patch.object(ec, 'load_model', side_effect=AssertionError('second model load')):
                self.assertEqual(server.demo(fresh=True)['model']['model'], 'resident')

    def test_http_index_returns_while_embedding_is_blocked(self):
        server.jobs = Jobs()
        release, entered = threading.Event(), threading.Event()
        def slow(name, body, progress):
            entered.set(); progress(1); release.wait(5)
            return 'doc', {'name': name, 'pages': 1}, True
        server.H.key = 'async-test'
        http = server.Server(('127.0.0.1', 0), server.H)
        thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
        address = f'http://127.0.0.1:{http.server_port}'
        try:
            with patch.object(server, 'index_file', side_effect=slow):
                with urlopen(Request(address + '/index', data=b'%PDF-test', headers={'X-RAG-Key':'async-test', 'X-File-Name':'test.pdf'}), timeout=1) as response:
                    self.assertEqual(response.status, 202)
                    job = json.load(response)
                self.assertTrue(entered.wait(1))
                with urlopen(Request(address + '/jobs?id=' + job['job'], headers={'X-RAG-Key':'async-test'}), timeout=1) as response:
                    self.assertEqual(json.load(response)['state'], 'running')
                release.set()
                for _ in range(200):
                    if server.jobs.get(job['job'])['state'] == 'done':
                        break
                    time.sleep(.01)
                self.assertEqual(server.jobs.get(job['job'])['result']['pages'], 1)
        finally:
            release.set(); http.shutdown(); http.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
