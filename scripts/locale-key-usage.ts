import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface UnusedLocaleKey {
  catalog: string;
  key: string;
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

const localeCataloguePath = (projectRoot: string, fileName: string): string | null => {
  const relativePath = path.relative(projectRoot, fileName).split(path.sep).join("/");
  if (/^src\/dashboard\/(?:locale|labels|module-labels|.*-locale)\.ts$/u.test(relativePath)) return relativePath;
  if (/^src\/modules\/[^/]+\/(?:panel|overlay)\/[^/]*locale[^/]*\.ts$/u.test(relativePath)) return relativePath;
  return null;
};

const listTypeScriptFiles = (directory: string): string[] => {
  if (!ts.sys.directoryExists(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(filePath);
      return /\.tsx?$/u.test(entry.name) ? [filePath] : [];
    });
};

interface CatalogueRecord {
  catalog: string;
  key: string;
  symbols: Set<ts.Symbol>;
}

const typeParts = (type: ts.Type): ts.Type[] =>
  type.isUnionOrIntersection() ? type.types.flatMap(typeParts) : [type];

const propertySymbols = (checker: ts.TypeChecker, types: readonly ts.Type[], name: string): ts.Symbol[] => {
  const symbols = new Set<ts.Symbol>();
  for (const type of types) {
    for (const part of typeParts(type)) {
      const symbol = checker.getPropertyOfType(part, name);
      if (symbol !== undefined) symbols.add(symbol);
    }
  }
  return [...symbols];
};

const propertyType = (checker: ts.TypeChecker, symbol: ts.Symbol, location: ts.Node): ts.Type =>
  checker.getTypeOfSymbolAtLocation(symbol, location);

const isCatalogPropertyDeclaration = (declaration: ts.Declaration): boolean =>
  ts.isPropertySignature(declaration)
  || ts.isPropertyAssignment(declaration)
  || ts.isPropertyDeclaration(declaration);

const isLocaleTextType = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  for (const part of typeParts(type)) {
    if ((part.flags & ts.TypeFlags.StringLike) !== 0) return true;
    for (const signature of checker.getSignaturesOfType(part, ts.SignatureKind.Call)) {
      const returnType = checker.getReturnTypeOfSignature(signature);
      if (typeParts(returnType).some((returnPart) => (returnPart.flags & ts.TypeFlags.StringLike) !== 0)) return true;
    }
  }
  return false;
};

const addCatalogueProperties = (
  checker: ts.TypeChecker,
  catalog: string,
  types: readonly ts.Type[],
  location: ts.Node,
  records: Map<string, CatalogueRecord>,
  ancestors: Set<ts.Type>,
): void => {
  for (const type of types) {
    for (const part of typeParts(type)) {
      if (ancestors.has(part)) continue;
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(part);

      for (const symbol of checker.getPropertiesOfType(part)) {
        const declarations = symbol.declarations ?? [];
        if (!declarations.some(isCatalogPropertyDeclaration)) continue;
        const valueType = propertyType(checker, symbol, location);
        const key = symbol.getName();
        if (isLocaleTextType(checker, valueType)) {
          const recordId = `${catalog}\u0000${key}`;
          const record = records.get(recordId) ?? { catalog, key, symbols: new Set<ts.Symbol>() };
          record.symbols.add(symbol);
          records.set(recordId, record);
        } else if (valueType.flags & ts.TypeFlags.Object) {
          addCatalogueProperties(checker, `${catalog}.${key}`, [valueType], location, records, nextAncestors);
        }
      }
    }
  }
};

const collectCatalogueProperties = (
  sourceFile: ts.SourceFile,
  catalogPath: string,
  checker: ts.TypeChecker,
  records: Map<string, CatalogueRecord>,
): void => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const catalog = `${catalogPath}#${declaration.name.text}`;
      const catalogType = checker.getTypeAtLocation(declaration.name);
      const languageSymbols = [
        ...propertySymbols(checker, [catalogType], "de"),
        ...propertySymbols(checker, [catalogType], "en"),
      ];
      if (languageSymbols.length < 2) continue;

      for (const language of ["de", "en"] as const) {
        const symbols = propertySymbols(checker, [catalogType], language);
        const languageTypes = symbols.map((symbol) => propertyType(checker, symbol, declaration.name));
        addCatalogueProperties(checker, catalog, languageTypes, declaration.name, records, new Set());
      }
    }
  }
};

const literalPropertyNames = (checker: ts.TypeChecker, expression: ts.Expression): string[] => {
  const names = new Set<string>();
  const addTypeNames = (type: ts.Type): void => {
    if (type.isUnion()) {
      type.types.forEach(addTypeNames);
      return;
    }
    if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
      names.add((type as ts.StringLiteralType).value);
    } else if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
      names.add(String((type as ts.NumberLiteralType).value));
    } else if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const constraint = checker.getBaseConstraintOfType(type);
      if (constraint !== undefined) addTypeNames(constraint);
    }
  };

  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) names.add(expression.text);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const constantValue = checker.getConstantValue(expression);
    if (typeof constantValue === "string" || typeof constantValue === "number") names.add(String(constantValue));
  }
  addTypeNames(checker.getTypeAtLocation(expression));
  return [...names];
};

const isWriteOnlyAccess = (node: ts.Expression): boolean => {
  const parent = node.parent;
  return (ts.isBinaryExpression(parent)
      && parent.left === node
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    || (ts.isDeleteExpression(parent) && parent.expression === node);
};

const markResolvedProperty = (
  checker: ts.TypeChecker,
  types: readonly ts.Type[],
  name: string,
  catalogueSymbols: ReadonlyMap<ts.Symbol, ReadonlySet<string>>,
  catalogueDeclarations: ReadonlyMap<ts.Declaration, ReadonlySet<string>>,
  usedRecords: Set<string>,
): void => {
  for (const symbol of propertySymbols(checker, types, name)) {
    for (const recordId of catalogueSymbols.get(symbol) ?? []) usedRecords.add(recordId);
    for (const declaration of symbol.declarations ?? []) {
      for (const recordId of catalogueDeclarations.get(declaration) ?? []) usedRecords.add(recordId);
    }
  }
};

const symbolRecords = (
  symbol: ts.Symbol,
  catalogueSymbols: ReadonlyMap<ts.Symbol, ReadonlySet<string>>,
  catalogueDeclarations: ReadonlyMap<ts.Declaration, ReadonlySet<string>>,
): Set<string> => {
  const records = new Set(catalogueSymbols.get(symbol) ?? []);
  for (const declaration of symbol.declarations ?? []) {
    for (const recordId of catalogueDeclarations.get(declaration) ?? []) records.add(recordId);
  }
  return records;
};

const bridgeContextualProperties = (
  checker: ts.TypeChecker,
  sourceType: ts.Type,
  targetType: ts.Type,
  location: ts.Node,
  catalogueSymbols: Map<ts.Symbol, Set<string>>,
  catalogueDeclarations: Map<ts.Declaration, Set<string>>,
  seen: WeakMap<ts.Type, WeakSet<ts.Type>>,
  localeKeys: ReadonlySet<string>,
): boolean => {
  if (!checker.isTypeAssignableTo(sourceType, targetType)) return false;
  const targets = seen.get(sourceType) ?? new WeakSet<ts.Type>();
  if (targets.has(targetType)) return false;
  targets.add(targetType);
  seen.set(sourceType, targets);
  let changed = false;

  for (const sourcePart of typeParts(sourceType)) {
    for (const sourceSymbol of checker.getPropertiesOfType(sourcePart)) {
      const key = sourceSymbol.getName();
      if (!localeKeys.has(key)) continue;
      const records = symbolRecords(sourceSymbol, catalogueSymbols, catalogueDeclarations);
      const sourceValueType = propertyType(checker, sourceSymbol, location);
      if (records.size === 0
        && ((sourceValueType.flags & ts.TypeFlags.Object) === 0
          || !hasDirectCatalogueProperty(checker, sourceValueType, catalogueSymbols, catalogueDeclarations, localeKeys))) continue;
      const targetSymbols = propertySymbols(checker, [targetType], key);
      if (targetSymbols.length === 0) continue;

      for (const targetSymbol of targetSymbols) {
        if (records.size > 0) {
          const symbols = catalogueSymbols.get(targetSymbol) ?? new Set<string>();
          for (const recordId of records) {
            if (!symbols.has(recordId)) changed = true;
            symbols.add(recordId);
          }
          catalogueSymbols.set(targetSymbol, symbols);
          for (const declaration of targetSymbol.declarations ?? []) {
            const declarations = catalogueDeclarations.get(declaration) ?? new Set<string>();
            for (const recordId of records) {
              if (!declarations.has(recordId)) changed = true;
              declarations.add(recordId);
            }
            catalogueDeclarations.set(declaration, declarations);
          }
        }

        const targetValueType = propertyType(checker, targetSymbol, location);
        if ((sourceValueType.flags & ts.TypeFlags.Object) !== 0 && (targetValueType.flags & ts.TypeFlags.Object) !== 0) {
          changed = bridgeContextualProperties(
            checker,
            sourceValueType,
            targetValueType,
            location,
            catalogueSymbols,
            catalogueDeclarations,
            seen,
            localeKeys,
          ) || changed;
        }
      }
    }
  }
  return changed;
};

const hasDirectCatalogueProperty = (
  checker: ts.TypeChecker,
  type: ts.Type,
  catalogueSymbols: ReadonlyMap<ts.Symbol, ReadonlySet<string>>,
  catalogueDeclarations: ReadonlyMap<ts.Declaration, ReadonlySet<string>>,
  localeKeys: ReadonlySet<string>,
): boolean => typeParts(type).some((part) =>
  checker.getPropertiesOfType(part).some((symbol) =>
    localeKeys.has(symbol.getName())
    && symbolRecords(symbol, catalogueSymbols, catalogueDeclarations).size > 0));

const markBindingPattern = (
  checker: ts.TypeChecker,
  pattern: ts.BindingName,
  ownerTypes: readonly ts.Type[],
  localeKeys: ReadonlySet<string>,
  catalogueSymbols: ReadonlyMap<ts.Symbol, ReadonlySet<string>>,
  catalogueDeclarations: ReadonlyMap<ts.Declaration, ReadonlySet<string>>,
  usedRecords: Set<string>,
): void => {
  if (!ts.isObjectBindingPattern(pattern)) return;
  for (const element of pattern.elements) {
    if (element.dotDotDotToken !== undefined) continue;
    const names = element.propertyName === undefined
      ? (ts.isIdentifier(element.name) ? [element.name.text] : [])
      : ts.isComputedPropertyName(element.propertyName)
        ? literalPropertyNames(checker, element.propertyName.expression)
        : ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName) || ts.isNumericLiteral(element.propertyName)
          ? [element.propertyName.text]
          : [];
    const nestedTypes: ts.Type[] = [];
    for (const name of names) {
      const hasNestedBinding = ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name);
      if (!localeKeys.has(name) && !hasNestedBinding) continue;
      const symbols = propertySymbols(checker, ownerTypes, name);
      if (localeKeys.has(name)) {
        markResolvedProperty(checker, ownerTypes, name, catalogueSymbols, catalogueDeclarations, usedRecords);
      }
      for (const symbol of symbols) nestedTypes.push(propertyType(checker, symbol, element));
    }
    if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      markBindingPattern(
        checker,
        element.name,
        nestedTypes,
        localeKeys,
        catalogueSymbols,
        catalogueDeclarations,
        usedRecords,
      );
    }
  }
};

const isContextualFlowExpression = (node: ts.Expression): boolean => {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) return parent.type !== undefined;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return true;
  if (ts.isJsxExpression(parent) && parent.expression === node && ts.isJsxAttribute(parent.parent)) return true;
  return ts.isReturnStatement(parent)
    && parent.expression === node
    && ts.isFunctionLike(parent.parent)
    && parent.parent.type !== undefined;
};

const mayContainCatalogueValue = (expression: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) return mayContainCatalogueValue(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    return mayContainCatalogueValue(expression.whenTrue) || mayContainCatalogueValue(expression.whenFalse);
  }
  return ts.isObjectLiteralExpression(expression)
    || ts.isIdentifier(expression)
    || ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression)
    || ts.isCallExpression(expression);
};

const propertyReads = (
  program: ts.Program,
  checker: ts.TypeChecker,
  localeKeys: ReadonlySet<string>,
  catalogueSymbols: Map<ts.Symbol, Set<string>>,
  catalogueDeclarations: Map<ts.Declaration, Set<string>>,
): Set<string> => {
  const usedRecords = new Set<string>();
  const contextualFlows = new WeakMap<ts.Type, WeakSet<ts.Type>>();
  const contextualExpressions: ts.Expression[] = [];
  const collectContextualFlows = (node: ts.Node): void => {
    if (ts.isExpression(node) && isContextualFlowExpression(node) && mayContainCatalogueValue(node)) {
      contextualExpressions.push(node);
    }
    ts.forEachChild(node, collectContextualFlows);
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) collectContextualFlows(sourceFile);
  }

  for (const expression of contextualExpressions) {
    const sourceType = checker.getTypeAtLocation(expression);
    if (!hasDirectCatalogueProperty(checker, sourceType, catalogueSymbols, catalogueDeclarations, localeKeys)) continue;
    const contextualType = checker.getContextualType(expression);
    if (contextualType !== undefined) {
      bridgeContextualProperties(
        checker,
        sourceType,
        contextualType,
        expression,
        catalogueSymbols,
        catalogueDeclarations,
        contextualFlows,
        localeKeys,
      );
    }
  }

  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !isWriteOnlyAccess(node)) {
      if (ts.isPropertyAccessExpression(node)) {
        if (localeKeys.has(node.name.text)) {
          const ownerType = checker.getTypeAtLocation(node.expression);
          markResolvedProperty(checker, [ownerType], node.name.text, catalogueSymbols, catalogueDeclarations, usedRecords);
        }
      } else {
        const names = literalPropertyNames(checker, node.argumentExpression).filter((name) => localeKeys.has(name));
        if (names.length > 0) {
          const ownerType = checker.getTypeAtLocation(node.expression);
          for (const name of names) {
            markResolvedProperty(checker, [ownerType], name, catalogueSymbols, catalogueDeclarations, usedRecords);
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) {
      const sourceType = node.initializer === undefined
        ? (node.type === undefined ? checker.getTypeAtLocation(node) : checker.getTypeAtLocation(node.type))
        : checker.getTypeAtLocation(node.initializer);
      markBindingPattern(checker, node.name, [sourceType], localeKeys, catalogueSymbols, catalogueDeclarations, usedRecords);
    } else if (ts.isParameter(node) && !ts.isIdentifier(node.name)) {
      const sourceType = node.type === undefined ? checker.getTypeAtLocation(node) : checker.getTypeAtLocation(node.type);
      markBindingPattern(checker, node.name, [sourceType], localeKeys, catalogueSymbols, catalogueDeclarations, usedRecords);
    }

    ts.forEachChild(node, visit);
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visit(sourceFile);
  }
  return usedRecords;
};

/** Find unreferenced properties declared by the dashboard's bilingual text catalogues. */
export const unusedLocaleKeys = (projectRoot = PROJECT_ROOT): UnusedLocaleKey[] => {
  const root = path.resolve(projectRoot);
  const configPath = path.join(root, "tsconfig.json");
  const configRead = ts.readConfigFile(configPath, (fileName) => ts.sys.readFile(fileName));
  if (configRead.error !== undefined) throw new Error(`Unable to read TypeScript configuration at ${configPath}`);
  const parsedConfig = ts.parseJsonConfigFileContent(configRead.config, ts.sys, root);
  const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
  const checker = program.getTypeChecker();
  const catalogueRecords = new Map<string, CatalogueRecord>();
  const catalogueFiles = listTypeScriptFiles(path.join(root, "src"))
    .map((fileName) => ({ fileName, catalog: localeCataloguePath(root, fileName) }))
    .filter((entry): entry is { fileName: string; catalog: string } => entry.catalog !== null);

  for (const { fileName, catalog } of catalogueFiles) {
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile !== undefined) collectCatalogueProperties(sourceFile, catalog, checker, catalogueRecords);
  }

  const catalogueSymbols = new Map<ts.Symbol, Set<string>>();
  const catalogueDeclarations = new Map<ts.Declaration, Set<string>>();
  for (const [recordId, record] of catalogueRecords) {
    for (const symbol of record.symbols) {
      const symbols = catalogueSymbols.get(symbol) ?? new Set<string>();
      symbols.add(recordId);
      catalogueSymbols.set(symbol, symbols);
      for (const declaration of symbol.declarations ?? []) {
        const declarations = catalogueDeclarations.get(declaration) ?? new Set<string>();
        declarations.add(recordId);
        catalogueDeclarations.set(declaration, declarations);
      }
    }
  }

  const localeKeys = new Set([...catalogueRecords.values()].map(({ key }) => key));
  const usedRecords = propertyReads(program, checker, localeKeys, catalogueSymbols, catalogueDeclarations);
  return [...catalogueRecords.entries()]
    .filter(([recordId]) => !usedRecords.has(recordId))
    .map(([, { catalog, key }]) => ({ catalog, key }))
    .sort((left, right) => left.catalog.localeCompare(right.catalog) || left.key.localeCompare(right.key));
};
