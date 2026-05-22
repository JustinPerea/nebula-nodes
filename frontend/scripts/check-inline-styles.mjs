import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const COMPONENTS_DIR = join(ROOT, 'src', 'components');

// Remotion composition renderers must use inline styles — the Remotion renderer
// serializes inline styles directly to the video frame; CSS class-based styling
// cannot be applied in the same way during server-side rendering. Any component
// subtree under this path is exempt from the static-inline-style guard.
const REMOTION_EXEMPT_PREFIX = join(COMPONENTS_DIR, 'video-editor', 'components');

const VISUAL_PROPS = new Set([
  'alignItems',
  'background',
  'backgroundColor',
  'border',
  'borderBottom',
  'borderColor',
  'borderLeft',
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

const files = collectFiles(COMPONENTS_DIR);
const violations = [];

for (const file of files) {
  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  visit(sourceFile, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.text !== 'style') return;
    if (!node.initializer || !ts.isJsxExpression(node.initializer)) return;
    const expr = node.initializer.expression;
    if (!expr || !ts.isObjectLiteralExpression(expr)) return;

    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = propertyName(prop.name);
      if (!name || !VISUAL_PROPS.has(name)) continue;
      if (!isStaticValue(prop.initializer)) continue;

      const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.name.getStart(sourceFile));
      violations.push({
        file: relative(ROOT, file),
        line: line + 1,
        column: character + 1,
        prop: name,
      });
    }
  });
}

if (violations.length > 0) {
  console.error('Static inline visual styles found. Move these to CSS classes, or make them dynamic data/geometry values:');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}:${violation.column} style.${violation.prop}`);
  }
  process.exit(1);
}

console.log(`Inline style guard passed (${files.length} component files scanned).`);

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
