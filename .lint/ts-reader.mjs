import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [nodeModules, root, ...files] = process.argv.slice(2);
const estree = await import(pathToFileURL(createRequire(path.join(nodeModules, 'index.js')).resolve('@typescript-eslint/typescript-estree')).href);

function read(text, file) {
  try {
    return estree.parse(text, { comment: true, loc: true, filePath: file, jsx: false, jsDocParsingMode: 'none' });
  } catch {
    return null;
  }
}

function specifiers(node, found) {
  if (Array.isArray(node)) {
    for (const item of node) specifiers(item, found);
    return;
  }
  if (!node || typeof node.type !== 'string') return;
  const literal = (value) => value && value.type === 'Literal' && typeof value.value === 'string';
  if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type) && literal(node.source)) {
    found.push({ line: node.loc.start.line, spec: node.source.value });
  } else if (node.type === 'ImportExpression' && literal(node.source)) {
    found.push({ line: node.loc.start.line, spec: node.source.value });
  } else if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference' && literal(node.moduleReference.expression)) {
    found.push({ line: node.loc.start.line, spec: node.moduleReference.expression.value });
  } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && literal(node.arguments[0])) {
    found.push({ line: node.loc.start.line, spec: node.arguments[0].value });
  }
  for (const [name, value] of Object.entries(node)) {
    if (name !== 'parent' && name !== 'loc' && name !== 'range' && value && typeof value === 'object') specifiers(value, found);
  }
}

const comments = [];
const imports = [];
const unread = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const tree = read(text, path.join(root, file));
  if (!tree) {
    unread.push(file);
    continue;
  }
  for (const comment of tree.comments) {
    comments.push({
      file, type: comment.type, value: comment.value,
      line: comment.loc.start.line, column: comment.loc.start.column, endLine: comment.loc.end.line, endColumn: comment.loc.end.column,
    });
  }
  const found = [];
  specifiers(tree.body, found);
  for (const item of found) imports.push({ file, ...item });
}
process.stdout.write(JSON.stringify({ comments, imports, unread }));
