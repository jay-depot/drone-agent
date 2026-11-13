import type { ActionReply, Job } from './types';
import { action } from './api';
import { Modal } from './Modal';
import { Button } from './Button';

const POLL_MS = 3000;

export function QueueModal(props: { onClose: () => void }) {
  const React = globalThis.React;
  const [jobs, setJobs] = React.useState<Job[]>([]);

  const load = React.useCallback(() => {
    return action<ActionReply<{ jobs: Job[] }>>('queue.list').then(reply =>
      setJobs(reply.body?.jobs ?? [])
    );
  }, []);

  React.useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  function retry(jobId: string): void {
    void action('queue.retry', { jobId }).then(load);
  }

  function cancel(jobId: string): void {
    void action('queue.cancel', { jobId }).then(load);
  }

  return (
    <Modal title="Queue" onClose={props.onClose}>
      <table className="dsp-queue-table">
        <thead>
          <tr>
            <th>State</th>
            <th>Card</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <tr key={job.id}>
              <td>
                <span className={`dsp-pill dsp-pill-${job.state}`}>
                  {job.state}
                </span>
              </td>
              <td>{job.cardId}</td>
              <td>{new Date(job.createdAt).toLocaleString()}</td>
              <td>
                {job.state === 'failed' ? (
                  <Button onClick={() => retry(job.id)}>Retry</Button>
                ) : null}
                {job.state === 'queued' ? (
                  <Button onClick={() => cancel(job.id)}>Cancel</Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
