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
  path: string[];
  rootCatalog: string;
}

interface CatalogueValue {
  catalog: string;
  languageSelected: boolean;
  path: string[];
  unknown: boolean;
}

interface CatalogueField {
  initializer?: ts.Expression;
  name: string;
  symbols: Set<ts.Symbol>;
}

const typeParts = (type: ts.Type): ts.Type[] =>
  type.isUnionOrIntersection() ? type.types.flatMap(typeParts) : [type];

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

const staticPropertyNames = (checker: ts.TypeChecker, name: ts.PropertyName): string[] => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return [name.text];
  return ts.isComputedPropertyName(name) ? literalPropertyNames(checker, name.expression) : [];
};

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) return unwrapExpression(expression.expression);
  return expression;
};

const catalogueFields = (
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
  types: readonly ts.Type[],
): CatalogueField[] => {
  const fields = new Map<string, CatalogueField>();
  const addSymbol = (symbol: ts.Symbol): void => {
    if (!(symbol.declarations ?? []).some(isCatalogPropertyDeclaration)) return;
    const field = fields.get(symbol.getName()) ?? { name: symbol.getName(), symbols: new Set<ts.Symbol>() };
    field.symbols.add(symbol);
    fields.set(field.name, field);
  };

  for (const type of types) {
    for (const part of typeParts(type)) {
      for (const symbol of checker.getPropertiesOfType(part)) addSymbol(symbol);
    }
  }

  const value = expression === undefined ? undefined : unwrapExpression(expression);
  if (value !== undefined && ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadType = checker.getTypeAtLocation(property.expression);
        for (const part of typeParts(spreadType)) {
          for (const symbol of checker.getPropertiesOfType(part)) addSymbol(symbol);
        }
        continue;
      }

      const name = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
        ? property.name
        : undefined;
      if (name === undefined) continue;
      for (const fieldName of staticPropertyNames(checker, name)) {
        const field = fields.get(fieldName) ?? { name: fieldName, symbols: new Set<ts.Symbol>() };
        if (ts.isPropertyAssignment(property)) field.initializer = property.initializer;
        else if (ts.isShorthandPropertyAssignment(property)) field.initializer = property.name;
        fields.set(fieldName, field);
      }
    }
  }

  return [...fields.values()].map((field) => ({
    ...field,
    symbols: new Set([...field.symbols].filter((symbol) =>
      (symbol.declarations ?? []).some(isCatalogPropertyDeclaration))),
  }));
};

const fieldTypes = (checker: ts.TypeChecker, field: CatalogueField, location: ts.Node): ts.Type[] => {
  const types = [...field.symbols].map((symbol) => propertyType(checker, symbol, location));
  if (field.initializer !== undefined) types.push(checker.getTypeAtLocation(field.initializer));
  return [...new Set(types)];
};

const addCatalogueProperties = (
  checker: ts.TypeChecker,
  catalog: string,
  expression: ts.Expression | undefined,
  types: readonly ts.Type[],
  location: ts.Node,
  records: Map<string, CatalogueRecord>,
  ancestors: Set<ts.Type>,
  propertyPath: string[] = [],
): void => {
  const fields = catalogueFields(checker, expression, types);
  for (const field of fields) {
    const valueTypes = fieldTypes(checker, field, location);
    if (valueTypes.length === 0) continue;
    const childPath = [...propertyPath, field.name];
    const textType = valueTypes.some((type) => isLocaleTextType(checker, type));
    if (textType) {
      const recordId = `${catalog}\u0000${JSON.stringify(childPath)}`;
      const groupPath = childPath.slice(0, -1).join(".");
      records.set(recordId, {
        catalog: groupPath.length === 0 ? catalog : `${catalog}.${groupPath}`,
        key: field.name,
        path: childPath,
        rootCatalog: catalog,
      });
    }

    const objectTypes = valueTypes.flatMap(typeParts).filter((type) => (type.flags & ts.TypeFlags.Object) !== 0);
    if (objectTypes.length === 0) continue;
    const nextAncestors = new Set(ancestors);
    const freshTypes = objectTypes.filter((type) => !nextAncestors.has(type));
    if (freshTypes.length === 0) continue;
    freshTypes.forEach((type) => nextAncestors.add(type));
    addCatalogueProperties(
      checker,
      catalog,
      field.initializer,
      objectTypes,
      field.initializer ?? location,
      records,
      nextAncestors,
      childPath,
    );
  }
};

const collectCatalogueProperties = (
  sourceFile: ts.SourceFile,
  catalogPath: string,
  checker: ts.TypeChecker,
  roots: Map<ts.Symbol, string>,
  records: Map<string, CatalogueRecord>,
): void => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const catalogSymbol = checker.getSymbolAtLocation(declaration.name);
      if (catalogSymbol === undefined) continue;

      const catalog = `${catalogPath}#${declaration.name.text}`;
      const catalogType = checker.getTypeAtLocation(declaration.name);
      const fields = catalogueFields(checker, declaration.initializer, [catalogType]);
      const languages = new Map(fields.map((field) => [field.name, field]));
      const german = languages.get("de");
      const english = languages.get("en");
      if (german === undefined || english === undefined) continue;

      roots.set(catalogSymbol, catalog);
      for (const language of [german, english]) {
        addCatalogueProperties(
          checker,
          catalog,
          language.initializer,
          fieldTypes(checker, language, declaration.name),
          declaration.name,
          records,
          new Set(),
        );
      }
    }
  }
};

const isWriteOnlyAccess = (node: ts.Expression): boolean => {
  const parent = node.parent;
  return (ts.isBinaryExpression(parent)
      && parent.left === node
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    || (ts.isDeleteExpression(parent) && parent.expression === node);
};

const resolvedSymbol = (checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined => {
  const symbol = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
};

const resolveCatalogueValue = (
  checker: ts.TypeChecker,
  expression: ts.Expression,
  roots: ReadonlyMap<ts.Symbol, string>,
): CatalogueValue | null => {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    const symbol = resolvedSymbol(checker, value);
    const catalog = symbol === undefined ? undefined : roots.get(symbol);
    return catalog === undefined
      ? null
      : { catalog, languageSelected: false, path: [], unknown: false };
  }

  if (ts.isPropertyAccessExpression(value)) {
    const owner = resolveCatalogueValue(checker, value.expression, roots);
    if (owner === null) {
      const member = resolvedSymbol(checker, value.name);
      const catalog = member === undefined ? undefined : roots.get(member);
      return catalog === undefined
        ? null
        : { catalog, languageSelected: false, path: [], unknown: false };
    }
    if (!owner.languageSelected) {
      if (value.name.text !== "de" && value.name.text !== "en") return null;
      return { ...owner, languageSelected: true };
    }
    return { ...owner, path: [...owner.path, value.name.text] };
  }

  if (ts.isElementAccessExpression(value)) {
    const owner = resolveCatalogueValue(checker, value.expression, roots);
    if (owner === null) return null;
    const names = literalPropertyNames(checker, value.argumentExpression);
    if (!owner.languageSelected) {
      const languageNames = names.filter((name) => name === "de" || name === "en");
      if (names.length > 0 && languageNames.length === 0) return null;
      return {
        ...owner,
        languageSelected: true,
      };
    }
    if (names.length === 1) {
      const [name] = names;
      if (name !== undefined) return { ...owner, path: [...owner.path, name] };
    }
    return { ...owner, unknown: true };
  }

  return null;
};

const propertyNames = (checker: ts.TypeChecker, name: ts.PropertyName | undefined): string[] => {
  if (name === undefined) return [];
  return staticPropertyNames(checker, name);
};

const markBindingPattern = (
  checker: ts.TypeChecker,
  pattern: ts.BindingName,
  source: CatalogueValue,
  markAll: (value: CatalogueValue) => void,
): void => {
  if (!ts.isObjectBindingPattern(pattern)) {
    markAll(source);
    return;
  }

  for (const element of pattern.elements) {
    if (element.dotDotDotToken !== undefined) {
      markAll({ ...source, path: [...source.path] });
      continue;
    }
    const names = propertyNames(checker, element.propertyName)
      .concat(element.propertyName === undefined && ts.isIdentifier(element.name) ? [element.name.text] : []);
    if (names.length === 0) {
      markAll(source);
      continue;
    }
    for (const name of names) {
      const selectsLanguage = !source.languageSelected && (name === "de" || name === "en");
      const child = selectsLanguage
        ? { ...source, languageSelected: true }
        : { ...source, path: [...source.path, name] };
      if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        markBindingPattern(checker, element.name, child, markAll);
      } else {
        markAll(child);
      }
    }
  }
};

const isDeclarationIdentifier = (node: ts.Node): boolean =>
  ts.isIdentifier(node)
  && !ts.isShorthandPropertyAssignment(node.parent)
  && (node.parent as ts.Node & { name?: ts.Node }).name === node;

const propertyReads = (
  program: ts.Program,
  checker: ts.TypeChecker,
  roots: ReadonlyMap<ts.Symbol, string>,
  records: ReadonlyMap<string, CatalogueRecord>,
): Set<string> => {
  const usedRecords = new Set<string>();
  const exactRecords = new Map<string, string[]>();
  const prefixRecords = new Map<string, string[]>();
  const fullyUsedPrefixes = new Set<string>();
  const pathKey = (catalog: string, propertyPath: readonly string[]): string =>
    `${catalog}\u0000${JSON.stringify(propertyPath)}`;
  for (const [recordId, record] of records) {
    for (let depth = 0; depth <= record.path.length; depth += 1) {
      const key = pathKey(record.rootCatalog, record.path.slice(0, depth));
      const prefix = prefixRecords.get(key) ?? [];
      prefix.push(recordId);
      prefixRecords.set(key, prefix);
    }
    const exactKey = pathKey(record.rootCatalog, record.path);
    const exact = exactRecords.get(exactKey) ?? [];
    exact.push(recordId);
    exactRecords.set(exactKey, exact);
  }
  const markExact = (value: CatalogueValue, propertyPath: string[]): void => {
    if (!value.languageSelected || value.unknown) return;
    for (const recordId of exactRecords.get(pathKey(value.catalog, propertyPath)) ?? []) usedRecords.add(recordId);
  };
  const markAll = (value: CatalogueValue): void => {
    const key = pathKey(value.catalog, value.path);
    if (fullyUsedPrefixes.has(key)) return;
    for (const recordId of prefixRecords.get(key) ?? []) usedRecords.add(recordId);
    fullyUsedPrefixes.add(key);
  };

  const handledDestructuringSources = new WeakSet<ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && !ts.isIdentifier(node.name)
      && node.initializer !== undefined) {
      const source = resolveCatalogueValue(checker, node.initializer, roots);
      if (source !== null) {
        if (ts.isObjectBindingPattern(node.name) && !source.unknown) {
          markBindingPattern(checker, node.name, source, markAll);
        } else {
          markAll(source);
        }
        handledDestructuringSources.add(unwrapExpression(node.initializer));
      }
    }

    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !isWriteOnlyAccess(node)) {
      const owner = resolveCatalogueValue(checker, node.expression, roots);
      if (owner !== null) {
        if (!owner.languageSelected) {
          // The first access selects de/en; it does not read a translated text key.
        } else if (owner.unknown) {
          markAll(owner);
        } else if (ts.isPropertyAccessExpression(node)) {
          markExact(owner, [...owner.path, node.name.text]);
        } else {
          const names = literalPropertyNames(checker, node.argumentExpression);
          if (names.length === 0) markAll(owner);
          else for (const name of names) markExact(owner, [...owner.path, name]);
        }
      }
    }

    if (ts.isExpression(node) && !isDeclarationIdentifier(node)) {
      const value = resolveCatalogueValue(checker, node, roots);
      const continuesAccess = (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent))
        && node.parent.expression === node;
      const isHandledDestructuringSource = handledDestructuringSources.has(unwrapExpression(node));
      const isLiteralTextRead = ts.isElementAccessExpression(node)
        && literalPropertyNames(checker, node.argumentExpression).length > 0
        && resolveCatalogueValue(checker, node.expression, roots)?.languageSelected === true
        && isLocaleTextType(checker, checker.getTypeAtLocation(node));
      if (value !== null
        && !continuesAccess
        && !isHandledDestructuringSource
        && !isLiteralTextRead
        && !isWriteOnlyAccess(node)) {
        markAll(value);
      }
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
  const roots = new Map<ts.Symbol, string>();
  const catalogueRecords = new Map<string, CatalogueRecord>();
  const catalogueFiles = listTypeScriptFiles(path.join(root, "src"))
    .map((fileName) => ({ fileName, catalog: localeCataloguePath(root, fileName) }))
    .filter((entry): entry is { fileName: string; catalog: string } => entry.catalog !== null);

  for (const { fileName, catalog } of catalogueFiles) {
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile !== undefined) collectCatalogueProperties(sourceFile, catalog, checker, roots, catalogueRecords);
  }

  const usedRecords = propertyReads(program, checker, roots, catalogueRecords);
  return [...catalogueRecords.entries()]
    .filter(([recordId]) => !usedRecords.has(recordId))
    .map(([, { catalog, key }]) => ({ catalog, key }))
    .sort((left, right) => left.catalog.localeCompare(right.catalog) || left.key.localeCompare(right.key));
};
