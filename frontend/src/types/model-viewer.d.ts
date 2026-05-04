import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          alt?: string;
          'auto-rotate'?: boolean | '';
          'camera-controls'?: boolean | '';
          'shadow-intensity'?: string | number;
        },
        HTMLElement
      >;
    }
  }
}
