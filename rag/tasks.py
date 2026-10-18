"""Bounded background jobs and cooperative access to the one resident model."""
from contextlib import contextmanager
import secrets
import threading
import time


class ModelGate:
    def __init__(self):
        self.condition = threading.Condition()
        self.busy = False
        self.waiting_queries = 0

    @contextmanager
    def use(self, interactive=False):
        with self.condition:
            if interactive:
                self.waiting_queries += 1
            try:
                while self.busy or (not interactive and self.waiting_queries):
                    self.condition.wait()
                self.busy = True
            finally:
                if interactive:
                    self.waiting_queries -= 1
        try:
            yield
        finally:
            with self.condition:
                self.busy = False
                self.condition.notify_all()

    def call(self, function, *args):
        with self.use():
            return function(*args)


class Jobs:
    def __init__(self, capacity=4, retained=64):
        self.lock = threading.Lock()
        self.items = {}
        self.capacity, self.retained = capacity, retained

    def start(self, key, task):
        with self.lock:
            active = [v for v in self.items.values() if v['state'] in ('queued', 'running')]
            for job in active:
                if job['key'] == key:
                    return self._view(job)
            if len(active) >= self.capacity:
                raise ValueError('진행 중인 작업이 많습니다. 잠시 후 다시 시도하세요.')
            completed = sorted((v for v in self.items.values() if v not in active), key=lambda v: v['time'])
            for job in completed[:max(0, len(self.items) - self.retained + 1)]:
                del self.items[job['job']]
            job = {'ok': True, 'job': secrets.token_hex(16), 'state': 'queued',
                   'pages_done': 0, 'key': key, 'time': time.monotonic()}
            self.items[job['job']] = job
            view = self._view(job)
        threading.Thread(target=self._run, args=(job, task), daemon=True).start()
        return view

    @staticmethod
    def _view(job):
        return {k: v for k, v in job.items() if k not in ('key', 'time')}

    def _run(self, job, task):
        def progress(pages):
            with self.lock:
                job['pages_done'] = pages
        with self.lock:
            job['state'] = 'running'
        try:
            result = task(progress)
            with self.lock:
                job.update(state='done', result=result)
        except Exception as error:
            with self.lock:
                job.update(state='error', error=str(error))

    def get(self, job_id):
        with self.lock:
            job = self.items.get(job_id)
            return self._view(job) if job else None
