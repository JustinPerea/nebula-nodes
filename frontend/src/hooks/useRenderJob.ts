import { useCallback, useEffect, useState } from 'react';
import { cancelRenderJob, getRenderJob, type RenderJob } from '../lib/renderJobs';
import { failureMessage } from '../lib/errorCopy';

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
          if (!disposed) setError(failureMessage(err, "Couldn't check the render."));
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
      // The starter's own heading ("Couldn't export the video.") when it has one.
      setError(failureMessage(err, "Couldn't start the render."));
    }
  }, []);

  const cancel = useCallback(async () => {
    if (!job || job.status !== 'running') return;
    try {
      setJob(await cancelRenderJob(job.id));
    } catch (err) {
      setError(failureMessage(err, "Couldn't cancel the render."));
    }
  }, [job]);

  const reset = useCallback(() => {
    setJob(null);
    setError(null);
  }, []);

  return { job, error, begin, cancel, reset };
}
