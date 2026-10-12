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

const isPropertyName = (name: ts.PropertyName | undefined): name is ts.Identifier | ts.StringLiteral | ts.NumericLiteral =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name));

interface CatalogueProperty {
  catalog: string;
  property: ts.PropertySignature | ts.PropertyAssignment;
  ownerType?: ts.Type;
}

interface PropertyRead {
  name: string;
  ownerType: ts.Type;
  declarations: Set<ts.Declaration>;
}

const isCatalogueTypeName = (name: string): boolean => /(?:Texts|Labels|Locale|Catalog)$/u.test(name);

const catalogueProperties = (
  sourceFile: ts.SourceFile,
  catalogPath: string,
  checker: ts.TypeChecker,
): CatalogueProperty[] => {
  const properties: CatalogueProperty[] = [];
  const collectType = (type: ts.TypeNode | undefined, catalog: string): void => {
    if (type === undefined) return;
    if (ts.isParenthesizedTypeNode(type)) {
      collectType(type.type, catalog);
      return;
    }
    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
      type.types.forEach((member) => { collectType(member, catalog); });
      return;
    }
    if (ts.isTypeReferenceNode(type)) {
      type.typeArguments?.forEach((argument) => { collectType(argument, catalog); });
      return;
    }
    if (!ts.isTypeLiteralNode(type)) return;
    for (const member of type.members) {
      if (!ts.isPropertySignature(member)) continue;
      properties.push({ catalog, property: member });
      collectType(member.type, `${catalog}.${isPropertyName(member.name) ? member.name.text : "inline"}`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && isCatalogueTypeName(node.name.text)) {
      const catalog = `${catalogPath}#${node.name.text}`;
      for (const member of node.members) {
        if (!ts.isPropertySignature(member)) continue;
        properties.push({ catalog, property: member });
        collectType(member.type, `${catalog}.${isPropertyName(member.name) ? member.name.text : "inline"}`);
      }
      return;
    }
    if (ts.isTypeAliasDeclaration(node) && isCatalogueTypeName(node.name.text)) {
      collectType(node.type, `${catalogPath}#${node.name.text}`);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const catalogName = ts.isIdentifier(node.name) ? node.name.text : "inline";
      const catalog = `${catalogPath}#${catalogName}`;
      collectType(node.type, catalog);
      if (node.type === undefined && node.initializer !== undefined) {
        const statement = node.parent;
        if (ts.isVariableDeclarationList(statement) && ts.isVariableStatement(statement.parent) && statement.parent.parent === sourceFile) {
          collectInferredObjectProperties(node.initializer, catalog, properties, checker);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return properties;
};

const collectInferredObjectProperties = (
  node: ts.Node,
  catalog: string,
  properties: CatalogueProperty[],
  checker: ts.TypeChecker,
): void => {
  if (ts.isParenthesizedExpression(node)) {
    collectInferredObjectProperties(node.expression, catalog, properties, checker);
    return;
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    collectInferredObjectProperties(node.expression, catalog, properties, checker);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectInferredObjectProperties(node.whenTrue, catalog, properties, checker);
    collectInferredObjectProperties(node.whenFalse, catalog, properties, checker);
    return;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (node.type !== undefined) return;
    if (ts.isBlock(node.body)) {
      for (const statement of node.body.statements) {
        if (ts.isReturnStatement(statement) && statement.expression !== undefined) {
          collectInferredObjectProperties(statement.expression, catalog, properties, checker);
        }
      }
    } else {
      collectInferredObjectProperties(node.body, catalog, properties, checker);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const ownerType = checker.getTypeAtLocation(node);
    for (const member of node.properties) {
      if (!ts.isPropertyAssignment(member) || !isPropertyName(member.name)) continue;
      const memberType = checker.getTypeAtLocation(member.initializer);
      if (member.initializer.kind === ts.SyntaxKind.StringLiteral || member.initializer.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral || (memberType.flags & ts.TypeFlags.StringLike) !== 0 || checker.getSignaturesOfType(memberType, ts.SignatureKind.Call).length > 0) {
        properties.push({ catalog, property: member, ownerType });
      }
      if (ts.isObjectLiteralExpression(member.initializer) || ts.isConditionalExpression(member.initializer)) {
        const nestedCatalog = member.name.text === "de" || member.name.text === "en" ? catalog : `${catalog}.${member.name.text}`;
        collectInferredObjectProperties(member.initializer, nestedCatalog, properties, checker);
      }
    }
  }
};

const markPropertyRead = (
  checker: ts.TypeChecker,
  expression: ts.Expression,
  name: string,
): PropertyRead => {
  const declarations = new Set<ts.Declaration>();
  const visitType = (type: ts.Type): void => {
    if (type.isUnionOrIntersection()) {
      type.types.forEach(visitType);
      return;
    }
    const symbol = checker.getPropertyOfType(type, name);
    for (const declaration of symbol?.declarations ?? []) declarations.add(declaration);
  };
  const ownerType = checker.getTypeAtLocation(expression);
  visitType(ownerType);
  return { name, ownerType, declarations };
};

const propertyReads = (program: ts.Program, checker: ts.TypeChecker, localeKeys: ReadonlySet<string>): Map<string, PropertyRead[]> => {
  const reads = new Map<string, PropertyRead[]>();
  const addRead = (read: PropertyRead): void => {
    const matchingReads = reads.get(read.name) ?? [];
    matchingReads.push(read);
    reads.set(read.name, matchingReads);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && localeKeys.has(node.name.text)) {
      addRead(markPropertyRead(checker, node.expression, node.name.text));
    } else if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) {
        if (localeKeys.has(argument.text)) addRead(markPropertyRead(checker, node.expression, argument.text));
      } else {
        const argumentType = checker.getTypeAtLocation(argument);
        const keys = argumentType.isUnion() ? argumentType.types : [argumentType];
        for (const key of keys) {
          if ((key.flags & ts.TypeFlags.StringLiteral) !== 0 || (key.flags & ts.TypeFlags.NumberLiteral) !== 0) {
            const name = String((key as ts.StringLiteralType | ts.NumberLiteralType).value);
            if (localeKeys.has(name)) addRead(markPropertyRead(checker, node.expression, name));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visit(sourceFile);
  }
  return reads;
};

const isTypeCompatible = (
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
  cache: WeakMap<ts.Type, WeakMap<ts.Type, boolean>>,
): boolean => {
  const cachedResult = cache.get(left)?.get(right);
  if (cachedResult !== undefined) return cachedResult;
  const compatible = checker.isTypeAssignableTo(left, right) || checker.isTypeAssignableTo(right, left);
  const leftCache = cache.get(left) ?? new WeakMap<ts.Type, boolean>();
  const rightCache = cache.get(right) ?? new WeakMap<ts.Type, boolean>();
  leftCache.set(right, compatible);
  rightCache.set(left, compatible);
  cache.set(left, leftCache);
  cache.set(right, rightCache);
  return compatible;
};

const sharesCatalogueShape = (
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
  compatibleTypes: WeakMap<ts.Type, WeakMap<ts.Type, boolean>>,
  shapeCache: WeakMap<ts.Type, WeakMap<ts.Type, boolean>>,
): boolean => {
  // Inferred catalogues often flow through narrower structural interfaces, such as a reusable text component's props.
  const cachedResult = shapeCache.get(left)?.get(right);
  if (cachedResult !== undefined) return cachedResult;
  const rightProperties = new Map(checker.getPropertiesOfType(right).map((property) => [property.getName(), property]));
  let compatibleProperties = 0;
  for (const leftProperty of checker.getPropertiesOfType(left)) {
    const rightProperty = rightProperties.get(leftProperty.getName());
    if (rightProperty === undefined) continue;
    const leftDeclaration = leftProperty.valueDeclaration ?? leftProperty.declarations?.[0];
    const rightDeclaration = rightProperty.valueDeclaration ?? rightProperty.declarations?.[0];
    if (leftDeclaration === undefined || rightDeclaration === undefined) continue;
    const leftType = checker.getTypeOfSymbolAtLocation(leftProperty, leftDeclaration);
    const rightType = checker.getTypeOfSymbolAtLocation(rightProperty, rightDeclaration);
    if (isTypeCompatible(checker, leftType, rightType, compatibleTypes)) compatibleProperties += 1;
    if (compatibleProperties >= 2) {
      const leftCache = shapeCache.get(left) ?? new WeakMap<ts.Type, boolean>();
      const rightCache = shapeCache.get(right) ?? new WeakMap<ts.Type, boolean>();
      leftCache.set(right, true);
      rightCache.set(left, true);
      shapeCache.set(left, leftCache);
      shapeCache.set(right, rightCache);
      return true;
    }
  }
  const leftCache = shapeCache.get(left) ?? new WeakMap<ts.Type, boolean>();
  const rightCache = shapeCache.get(right) ?? new WeakMap<ts.Type, boolean>();
  leftCache.set(right, false);
  rightCache.set(left, false);
  shapeCache.set(left, leftCache);
  shapeCache.set(right, rightCache);
  return false;
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
  const catalogueFiles = listTypeScriptFiles(path.join(root, "src"))
    .map((fileName) => ({ fileName, catalog: localeCataloguePath(root, fileName) }))
    .filter((entry): entry is { fileName: string; catalog: string } => entry.catalog !== null);
  const cataloguePropertiesList = catalogueFiles.flatMap(({ fileName, catalog }) => {
    const sourceFile = program.getSourceFile(fileName);
    return sourceFile === undefined ? [] : catalogueProperties(sourceFile, catalog, checker);
  });
  const localeKeys = new Set(cataloguePropertiesList.flatMap(({ property }) => isPropertyName(property.name) ? [property.name.text] : []));
  const reads = propertyReads(program, checker, localeKeys);
  const compatibleTypes = new WeakMap<ts.Type, WeakMap<ts.Type, boolean>>();
  const shapeCache = new WeakMap<ts.Type, WeakMap<ts.Type, boolean>>();
  const unused = new Map<string, UnusedLocaleKey>();

  for (const { catalog: catalogName, property, ownerType } of cataloguePropertiesList) {
    if (!isPropertyName(property.name)) continue;
    const key = property.name.text;
    const isUsed = (reads.get(key) ?? []).some((read) =>
      read.declarations.has(property)
      || (key === read.name && ownerType !== undefined
        && (isTypeCompatible(checker, ownerType, read.ownerType, compatibleTypes)
          || sharesCatalogueShape(checker, ownerType, read.ownerType, compatibleTypes, shapeCache))));
    if (isUsed) continue;

    unused.set(`${catalogName}:${key}`, { catalog: catalogName, key });
  }

  return [...unused.values()].sort((left, right) =>
    left.catalog.localeCompare(right.catalog) || left.key.localeCompare(right.key));
};
