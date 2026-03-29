import ts from "typescript";

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  parseDiagnostics?: readonly ts.Diagnostic[];
};

function getParseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  const pd = (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics;
  return pd ?? [];
}

/**
 * Fast syntax validation for TS/JS code snippets.
 * Returns true if the code is syntactically correct.
 */
export function isSyntaxValid(code: string, fileName: string = "candidate.ts"): boolean {
  try {
    const sourceFile = ts.createSourceFile(
      fileName,
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const diagnostics = getParseDiagnostics(sourceFile);
    return diagnostics.length === 0;
  } catch {
    return false;
  }
}

/**
 * Extract specific declarations (functions, classes, interfaces) from code.
 * Useful for pruning large files down to relevant context.
 */
export function extractRelevantNodes(
  code: string, 
  targetNames: string[], 
  options: { includeSignaturesOnlyForOthers?: boolean } = {}
): string {
  const sourceFile = ts.createSourceFile(
    "temp.ts",
    code,
    ts.ScriptTarget.Latest,
    true
  );

  const printer = ts.createPrinter({ removeComments: false });
  const resultNodes: ts.Node[] = [];
  const targets = new Set(targetNames);

  function visitor(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const name = node.name?.getText(sourceFile);
      if (name && targets.has(name)) {
        resultNodes.push(node);
      } else if (options.includeSignaturesOnlyForOthers) {
        // Future: implement signature-only extraction (e.g. stripping bodies)
        // For now, we skip non-targets to maximize pruning
      }
    } else if (ts.isVariableStatement(node)) {
      // Check if any of the declarations are targets
      const isTarget = node.declarationList.declarations.some(d => 
        targets.has(d.name.getText(sourceFile))
      );
      if (isTarget) resultNodes.push(node);
    }
  }

  ts.forEachChild(sourceFile, visitor);

  if (resultNodes.length === 0) {
    // Fallback: if no targets found, maybe it's a small file, return as is
    return code;
  }

  return resultNodes
    .map(node => printer.printNode(ts.EmitHint.Unspecified, node, sourceFile))
    .join("\n\n");
}
