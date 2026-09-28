import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, extname, join } from 'node:path';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const under = (path, directory) => path.startsWith(directory + '/');
const normalize = path => path.replaceAll('\\', '/');

/** Analyze source dependencies without evaluating application modules. */
export async function analyzeBoundaries(root) {
  root = resolve(root);
  const files = new Map(), resources = new Set();
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (['node_modules', 'dist', 'tests', '.git'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const name = normalize(relative(root, path));
        resources.add(name);
        if (/\.(?:ts|tsx|vue)$/.test(entry.name)) files.set(name, await readFile(path, 'utf8'));
      }
    }
  }
  await walk(join(root, 'src'));
  const issues = [], edges = [];
  const issue = (kind, from, to, message) => issues.push({ kind, from, to, message });
  function resolveImport(from, specifier) {
    const base = normalize(relative(root, resolve(root, dirname(from), specifier)));
    const candidates = [base];
    if (/\.m?js$/.test(base)) candidates.push(base.replace(/\.m?js$/, '.ts'), base.replace(/\.m?js$/, '.tsx'), base.replace(/\.m?js$/, '.vue'));
    if (!extname(base)) candidates.push(...['.ts', '.tsx', '.vue', '/index.ts', '/index.tsx'].map(suffix => base + suffix));
    return candidates.find(path => resources.has(path));
  }
  function dependency(from, specifier, typeOnly) {
    const local = specifier.startsWith('.');
    const to = local ? resolveImport(from, specifier) : specifier;
    if (!to) { issue('unresolved', from, specifier, `${typeOnly ? 'type' : 'runtime'} relative import cannot be resolved`); return; }
    edges.push({ from, to, typeOnly });
    const runtime = !typeOnly;
    const boundary = message => issue(typeOnly ? 'type-boundary' : 'runtime-boundary', from, to, message);
    if (under(from, 'src/contracts') && (!local || !under(to, 'src/contracts'))) {
      boundary('foundation contracts may depend only on their own leaf modules, including type dependencies');
    }
    if (runtime && under(from, 'src') && !under(from, 'src/app') && !under(from, 'src/cli') &&
      (under(to, 'src/app') || under(to, 'src/cli'))) boundary('library cannot depend on an application or CLI entrypoint');
    if (runtime && under(from, 'src/tools') && under(to, 'src/agent')) boundary('tools cannot depend on agent implementation');
    if (runtime && under(from, 'src/model') && ['src/agent', 'src/tools', 'src/onebot'].some(dir => under(to, dir))) boundary('model cannot depend on agent, tools or OneBot implementation');
    if (under(from, 'src/dashboard/web/src')) {
      if (builtins.has(to)) boundary('dashboard web cannot depend on Node builtins');
      else if (local && !under(to, 'src/dashboard/web/src') && !under(to, 'src/dashboard/contracts')) boundary('dashboard web local dependencies must remain in web/src or contracts');
    }
    if (under(from, 'src/dashboard/contracts') && runtime &&
      (builtins.has(to) || (local && !under(to, 'src/dashboard/contracts')))) boundary('dashboard contracts must remain pure DTO/computation modules');
    if (runtime && under(from, 'src/dashboard/server') &&
      (under(to, 'src/app') || under(to, 'src/cli') || (under(to, 'src/agent') && to !== 'src/agent/session/indexes.ts'))) boundary('dashboard server cannot depend on application, CLI or agent runtime objects');
  }
  for (const [from, raw] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const sources = from.endsWith('.vue') ? [...raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]) : [raw];
    for (const source of sources) {
      const ast = ts.createSourceFile(from, source, ts.ScriptTarget.Latest, true, from.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const literal = node => ts.isStringLiteralLike(node) ? node.text : undefined;
      function visit(node) {
        let specifier, typeOnly = false;
        if (ts.isImportDeclaration(node)) {
          specifier = literal(node.moduleSpecifier);
          const clause = node.importClause;
          typeOnly = !!clause?.isTypeOnly || !!(clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length && clause.namedBindings.elements.every(item => item.isTypeOnly));
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
          specifier = literal(node.moduleSpecifier);
          typeOnly = node.isTypeOnly || !!(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(item => item.isTypeOnly));
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
          specifier = literal(node.argument.literal); typeOnly = true;
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          specifier = node.arguments[0] && literal(node.arguments[0]);
          if (specifier === undefined) issue('unresolved-dynamic', from, node.arguments[0]?.getText(ast) ?? '<missing>', 'runtime dynamic import cannot be resolved statically');
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
          specifier = literal(node.moduleReference.expression); typeOnly = node.isTypeOnly;
        }
        if (specifier !== undefined) dependency(from, specifier, typeOnly);
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  // DFS over production runtime edges only. Type dependencies never form runtime cycles.
  const graph = new Map([...files.keys()].filter(path => under(path, 'src')).map(path => [path, []]));
  for (const edge of edges) if (!edge.typeOnly && graph.has(edge.from) && graph.has(edge.to)) graph.get(edge.from).push(edge.to);
  const visited = new Set(), active = new Set(), stack = [];
  function visit(path) {
    if (active.has(path)) { const cycle = [...stack.slice(stack.indexOf(path)), path]; issue('runtime-cycle', stack.at(-1), path, cycle.join(' -> ')); return; }
    if (visited.has(path)) return;
    active.add(path); stack.push(path);
    for (const next of graph.get(path)) visit(next);
    stack.pop(); active.delete(path); visited.add(path);
  }
  for (const path of [...graph.keys()].sort()) visit(path);
  return { files: files.size, edges, issues };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  analyzeBoundaries(process.argv[2] ?? process.cwd()).then(result => {
    if (!result.files) throw new Error('No production source files discovered');
    for (const issue of result.issues) console.error(`${issue.kind}: ${issue.from} -> ${issue.to}: ${issue.message}`);
    console.log(`Boundaries: ${result.files} files, ${result.issues.length} violations`);
    process.exitCode = result.issues.length ? 1 : 0;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
