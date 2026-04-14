declare namespace JSX {
  interface IntrinsicElements {
    'model-viewer': React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        alt?: string;
        'camera-controls'?: boolean;
        'auto-rotate'?: boolean;
        'shadow-intensity'?: string;
        'environment-image'?: string;
        poster?: string;
        style?: React.CSSProperties;
      },
      HTMLElement
    >;
  }
}
