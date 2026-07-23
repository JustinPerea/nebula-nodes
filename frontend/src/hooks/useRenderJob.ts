import { useCallback, useEffect, useState } from 'react';
import { cancelRenderJob, getRenderJob, type RenderJob } from '../lib/renderJobs';

export function useRenderJob() {
  const [job, setJob] = useState<RenderJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobId = job?.id;
  const jobStatus = job?.status;

  useEffect(() => {
    if (!jobId || jobStatus !== 'running') return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void getRenderJob(jobId)
        .then((next) => {
          if (!disposed) {
            setJob(next);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!disposed) setError(err instanceof Error ? err.message : String(err));
        });
    }, 350);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [jobId, jobStatus]);

  const begin = useCallback(async (starter: () => Promise<RenderJob>) => {
    setError(null);
    try {
      const next = await starter();
      setJob(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const cancel = useCallback(async () => {
    if (!job || job.status !== 'running') return;
    try {
      setJob(await cancelRenderJob(job.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [job]);

  const reset = useCallback(() => {
    setJob(null);
    setError(null);
  }, []);

  return { job, error, begin, cancel, reset };
}
