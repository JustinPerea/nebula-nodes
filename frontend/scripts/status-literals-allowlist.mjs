// Colours that are not statuses, by file and selector, each with the reason. A new status literal
// inside one of these files still fails, unless the entry covers the whole file (`whole: true`,
// and the reason says why).
//
// Stylesheet entries: { file, selector?, prop?, whole?, reason }. `selector` is a substring of the
// rule's selector or a RegExp, `prop` a prefix or a RegExp. Script entries (TS_ALLOWLIST) are whole
// files, and only colour tables; one-off literals take a `// palette-exempt: <reason>` comment.

export const ALLOWLIST = [
  // Token definitions: a token's own value is written once, here.
  {
    file: 'styles/slava-restraint.css',
    selector: /^body\.app-slava-restraint$/,
    prop: /^--(?:sr|nn-crab)-/,
    reason: 'the palette tokens and the brand crab gradient are defined here',
  },
  { file: 'styles/disabled-buttons.css', selector: ':root', prop: '--sr-danger', reason: 'the destructive red tokens are defined here' },
  { file: 'styles/slava-restraint.css', selector: '.debug-handles', reason: 'developer debug overlay (red outline, lime centre), not product UI' },
  { file: 'styles/canvas.css', selector: '.nn-splash__wordmark-line--warm', reason: 'brand splash wordmark (the crab warm colour and its fallback)' },
  { file: 'styles/settings.css', selector: '.settings-apps__swatch--auto', reason: 'conic gradient of the per-agent identity colours (ConnectedApps.tsx)' },
  { file: 'styles/paper-source-node.css', selector: '.paper-source-node__handle', reason: 'the Paper output handle is drawn in its port colour' },
  // A standalone theme: the Commons labelling page has its own olive ground and redefines
  // --sr-accent, --sr-ink and --sr-edge on body.commons-labeling-page. Design: left alone.
  { file: 'styles/commons-evaluation.css', whole: true, reason: 'the Commons labelling page is a standalone olive theme (design); every rule in the file is that theme' },
  { file: 'styles/commons-review.css', whole: true, reason: 'the Commons labelling page is a standalone olive theme (design); every rule in the file is that theme' },
  { file: 'styles/commons-labeling-page.css', whole: true, reason: 'the Commons labelling page theme itself' },
  { file: 'components/brand/BrandShowcase.css', whole: true, reason: 'the brand showcase page is painted in the brand colours (--nn-crab-*), a brand surface and not product UI' },
  // Open PR #269 rewrites these three rules onto tokens; delete these entries when it merges.
  { file: 'styles/character-studio.css', selector: '.character-studio-toolbar__state--error', reason: 'PR #269 moves this rule onto --sr-error' },
  { file: 'styles/moodboard-studio.css', selector: '.moodboard-studio-toolbar__state--saved', reason: 'PR #269 moves this rule onto a token' },
  { file: 'styles/moodboard-studio.css', selector: '.moodboard-studio-toolbar__state--error', reason: 'PR #269 moves this rule onto --sr-error' },
];

export const TS_ALLOWLIST = [
  { file: 'constants/ports.ts', reason: 'node category colours: data, not status' },
  { file: 'lib/portCompatibility.ts', reason: 'port type colours: data, not status' },
  { file: 'lib/referenceRoles.ts', reason: 'reference role colours: data, not status' },
  { file: 'lib/jev.ts', reason: 'the JEV brand colours (accent and soft): data, not status' },
];
