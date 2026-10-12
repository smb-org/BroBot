import { readFileSync, readdirSync } from "node:fs";
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

const createLanguageService = (projectRoot: string): ts.LanguageService => {
  const configPath = path.join(projectRoot, "tsconfig.json");
  const configRead = ts.readConfigFile(configPath, (fileName) => ts.sys.readFile(fileName));
  if (configRead.error !== undefined) {
    throw new Error(`Unable to read TypeScript configuration at ${configPath}`);
  }

  const parsedConfig = ts.parseJsonConfigFileContent(configRead.config, ts.sys, projectRoot);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => parsedConfig.fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      const content = ts.sys.readFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => projectRoot,
    getCompilationSettings: () => parsedConfig.options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (fileName) => ts.sys.fileExists(fileName),
    readFile: (fileName) => ts.sys.readFile(fileName),
    readDirectory: (rootDir, extensions, excludes, includes, depth) => ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth),
    directoryExists: (directory) => ts.sys.directoryExists(directory),
    getDirectories: (directory) => ts.sys.getDirectories(directory),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };

  return ts.createLanguageService(host, ts.createDocumentRegistry());
};

const isPropertyName = (name: ts.PropertyName | undefined): name is ts.Identifier | ts.StringLiteral | ts.NumericLiteral =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name));

interface CatalogueProperty {
  catalog: string;
  property: ts.PropertySignature;
}

const isCatalogueTypeName = (name: string): boolean => /(?:Texts|Labels|Locale|Catalog)$/u.test(name);

const propertySignatures = (sourceFile: ts.SourceFile, catalogPath: string): CatalogueProperty[] => {
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
      collectType(node.type, `${catalogPath}#${catalogName}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return properties;
};

const hasReadReference = (
  languageService: ts.LanguageService,
  fileName: string,
  propertyName: ts.Identifier | ts.StringLiteral | ts.NumericLiteral,
): boolean => {
  const groups = languageService.findReferences(fileName, propertyName.getStart());
  return groups?.some((group) => group.references.some((reference) => !reference.isDefinition && !reference.isWriteAccess)) ?? false;
};

/** Find unreferenced properties declared by the dashboard's bilingual text catalogues. */
export const unusedLocaleKeys = (projectRoot = PROJECT_ROOT): UnusedLocaleKey[] => {
  const root = path.resolve(projectRoot);
  const languageService = createLanguageService(root);
  const catalogueFiles = listTypeScriptFiles(path.join(root, "src"))
    .map((fileName) => ({ fileName, catalog: localeCataloguePath(root, fileName) }))
    .filter((entry): entry is { fileName: string; catalog: string } => entry.catalog !== null);
  const unused = new Map<string, UnusedLocaleKey>();

  for (const { fileName, catalog } of catalogueFiles) {
    const sourceText = readFileSync(fileName, "utf8");
    const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
    for (const { catalog: catalogName, property } of propertySignatures(sourceFile, catalog)) {
      if (!isPropertyName(property.name)) continue;
      if (hasReadReference(languageService, fileName, property.name)) continue;

      const key = property.name.text;
      unused.set(`${catalogName}:${key}`, { catalog: catalogName, key });
    }
  }

  return [...unused.values()].sort((left, right) =>
    left.catalog.localeCompare(right.catalog) || left.key.localeCompare(right.key));
};
