import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = process.cwd();
const COMPONENTS_DIR = join(ROOT, 'src', 'components');

// Known limits of the left-edge keys below (scripts/check-left-edge.mjs has the stylesheet side):
// scanSource reads only an object literal written directly in style={{ ... }}. A conditional
// (style={cond ? { ... } : undefined}), a variable (style={s}), a spread, or a computed key is
// not read, and neither is a borderWidth / borderColor list or a background gradient. A colour
// set from TSX through var() is not seen by the stylesheet check. No dataflow is tried.
//
// Remotion composition renderers must use inline styles — the Remotion renderer
// serializes inline styles directly to the video frame; CSS class-based styling
// cannot be applied in the same way during server-side rendering. The entire
// video-editor/ subtree is exempt: RemotionComposition.tsx (at this level) and
// all render components under components/ both require inline styles.
const REMOTION_EXEMPT_PREFIX = join(COMPONENTS_DIR, 'video-editor');

const VISUAL_PROPS = new Set([
  'alignItems',
  'background',
  'backgroundColor',
  'border',
  'borderBottom',
  'borderColor',
  'borderInlineStart',
  'borderInlineStartColor',
  'borderInlineStartWidth',
  'borderLeft',
  'borderLeftColor',
  'borderLeftWidth',
  'borderRadius',
  'borderRight',
  'borderTop',
  'boxShadow',
  'color',
  'display',
  'filter',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'gap',
  // A studio's grid is its stylesheet's (PR #209).
  'grid',
  'gridArea',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnStart',
  'gridRow',
  'gridRowEnd',
  'gridRowStart',
  'gridTemplate',
  'gridTemplateAreas',
  'gridTemplateColumns',
  'gridTemplateRows',
  'height',
  'justifyContent',
  'lineHeight',
  'margin',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'marginTop',
  'maxHeight',
  'maxWidth',
  'minHeight',
  'minWidth',
  'opacity',
  'outline',
  'padding',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'textAlign',
  'transform',
  'width',
  'zIndex',
]);

/**
 * Design: no accent bar down the left edge, in an inline style either. A style object key
 * borderLeft*, borderInlineStart* (or border-left*, quoted), or a boxShadow whose value text
 * holds `inset`, fails whether the value is a literal or computed (a template literal with the
 * agent's colour is the case this is for).
 */
const EDGE_KEY = /^(border-?left|border-?inline-?start)/i;
const edgeKey = (name) => EDGE_KEY.test(name);

/** The static-visual and left-edge problems in one source file: { staticStyles, edges } of { file, line, column, prop }. */
export function scanSource(sourceText, file) {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const staticStyles = [];
  const edges = [];

  visit(sourceFile, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.text !== 'style') return;
    if (!node.initializer || !ts.isJsxExpression(node.initializer)) return;
    const expr = node.initializer.expression;
    if (!expr || !ts.isObjectLiteralExpression(expr)) return;

    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
      const name = propertyName(prop.name);
      if (!name) continue;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.name.getStart(sourceFile));
      const where = { file, line: line + 1, column: character + 1, prop: name };

      const value = ts.isPropertyAssignment(prop) ? prop.initializer.getText(sourceFile) : name;
      if (edgeKey(name) || (/^box-?shadow$/i.test(name) && /\binset\b/i.test(value))) {
        edges.push(where);
        continue;
      }
      if (!ts.isPropertyAssignment(prop) || !VISUAL_PROPS.has(name)) continue;
      if (!isStaticValue(prop.initializer)) continue;
      staticStyles.push(where);
    }
  });
  return { staticStyles, edges };
}

function main() {
  const files = collectFiles(COMPONENTS_DIR);
  const violations = [];
  const edges = [];
  for (const file of files) {
    const found = scanSource(readFileSync(file, 'utf8'), relative(ROOT, file));
    violations.push(...found.staticStyles);
    edges.push(...found.edges);
  }

  if (violations.length > 0 || edges.length > 0) {
    if (violations.length > 0) {
      console.error('Static inline visual styles found. Move these to CSS classes, or make them dynamic data/geometry values:');
      for (const violation of violations) {
        console.error(`  ${violation.file}:${violation.line}:${violation.column} style.${violation.prop}`);
      }
    }
    if (edges.length > 0) {
      console.error('Left-edge accent in an inline style (static or computed). Set the block apart with a label, a fill or space, not an edge down its left side:');
      for (const edge of edges) {
        console.error(`  ${edge.file}:${edge.line}:${edge.column} style.${edge.prop}`);
      }
    }
    process.exit(1);
  }

  console.log(`Inline style guard passed (${files.length} component files scanned).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    // Skip Remotion composition renderers — they require inline styles.
    if (path.startsWith(REMOTION_EXEMPT_PREFIX)) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...collectFiles(path));
    } else if (/\.(tsx|jsx)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

function visit(node, cb) {
  cb(node);
  ts.forEachChild(node, (child) => visit(child, cb));
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function isStaticValue(node) {
  return (
    ts.isStringLiteral(node)
    || ts.isNumericLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword
  );
}
