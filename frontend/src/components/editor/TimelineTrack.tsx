import { type EditClip } from '../../lib/editor/virtualPlayback';
import { TimelineClip } from './TimelineClip';
import { WaveformAudio } from './WaveformAudio';

interface Props {
  type: 'video' | 'audio';
  clips: EditClip[];
  sourceDuration: number;
  sourceFps: number;
  editNodeId: string;
  /** Reserved for Task 21 (wavesurfer waveform on the audio track). */
  sourceUrl?: string;
}

export function TimelineTrack({ type, clips, sourceDuration, sourceFps, editNodeId, sourceUrl }: Props) {
  return (
    <div className={`editor-tl__track editor-tl__track--${type}`}>
      <div className="editor-tl__track-label">{type === 'video' ? 'VID' : 'AUD'}</div>
      <div className="editor-tl__track-body">
        {type === 'audio' && sourceUrl && <WaveformAudio sourceUrl={sourceUrl} />}
        {clips.map((clip, i) => (
          <TimelineClip
            key={clip.id}
            clip={clip}
            index={i}
            track={type}
            sourceDuration={sourceDuration}
            sourceFps={sourceFps}
            editNodeId={editNodeId}
          />
        ))}
      </div>
    </div>
  );
}
