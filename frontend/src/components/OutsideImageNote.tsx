import { OUTSIDE_IMAGE_NOTE } from '../lib/storedImage';
import '../styles/outside-image-note.css';

/** Where a saved Style's or Character's image would be when it points outside
 *  Nebula: that image is never loaded (lib/storedImage.ts), and this says why. */
export function OutsideImageNote() {
  return (
    <span className="outside-image-note" title="This image is a link to another site, so Nebula doesn't load it. Replace it with an upload.">
      {OUTSIDE_IMAGE_NOTE}
    </span>
  );
}
