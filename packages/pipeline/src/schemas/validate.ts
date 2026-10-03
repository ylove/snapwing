// XML validation: XSD for structure, Schematron for cross-references (main 4.2, main 9.2).
// Toolchain and its limits: build/decisions/0010-xml-validation-toolchain.md.
//
// Every function here resolves to a result and never throws or rejects: an invalid document,
// a malformed document, an unreadable schema, and a schema that fails to compile are all
// reported as `{ valid: false, errors }`. Callers (for example prompt synthesis, main 9.2)
// branch on `valid` and never need a try/catch.

import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Schema } from 'node-schematron';
import { validateXML, type XMLFileInfo } from 'xmllint-wasm';

export interface ValidationError {
  /** 1-based line in the validated document, when the validator can locate the error. */
  line?: number;
  message: string;
  /** Id of the Schematron assert or report that fired, when the error comes from a rule. */
  rule?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface SchemaPaths {
  /** Path to the XSD. */
  xsd: string;
  /** Path to the Schematron rules; run only when the XSD passes. */
  sch?: string;
}

const DOCUMENT_FILE_NAME = 'document.xml';

/**
 * Validate `xml` against the XSD at `xsdPath` with libxml2 (compiled to WASM, no native build).
 * Sibling `.xsd` files in the schema's directory are made available so `xs:include` and
 * `xs:import` with a bare relative `schemaLocation` resolve.
 */
export async function validateXsd(xml: string, xsdPath: string): Promise<ValidationResult> {
  try {
    const schema: XMLFileInfo = { fileName: basename(xsdPath), contents: await readFile(xsdPath, 'utf8') };
    const result = await validateXML({
      xml: { fileName: DOCUMENT_FILE_NAME, contents: xml },
      schema,
      preload: await siblingSchemas(xsdPath),
    });
    if (result.valid) return { valid: true, errors: [] };
    // For a malformed document libxml2 also prints the offending source line and a caret
    // line; those come back as unlocated "errors". Keep only located ones when there are any.
    const located = result.errors.filter((e) => e.loc !== null);
    const errors = (located.length > 0 ? located : result.errors)
      .map((e): ValidationError => {
        const message = e.message.trim();
        return e.loc && e.loc.fileName === DOCUMENT_FILE_NAME ? { line: e.loc.lineNumber, message } : { message };
      })
      .filter((e) => e.message.length > 0);
    return failed(errors.length > 0 ? errors : [{ message: 'XSD validation failed with no diagnostic output' }]);
  } catch (err) {
    // xmllint-wasm rejects when the schema itself does not compile.
    return failed([{ message: `XSD ${basename(xsdPath)} could not be applied: ${describe(err)}` }]);
  }
}

/**
 * Validate `xml` against the Schematron rules at `schPath` (fontoxpath, so XPath 3.1, pure JS).
 * Each failed `assert` and each fired `report` is one error; its message is the rule's text
 * with `value-of` and `name` expanded and whitespace collapsed. `sch:include` hrefs resolve
 * relative to the including file.
 */
export async function validateSchematron(xml: string, schPath: string): Promise<ValidationResult> {
  let schema: Schema;
  try {
    schema = await Schema.fromString(await readFile(schPath, 'utf8'), {
      fetchReference: (href, chain) => readFile(resolveInclude(schPath, chain, href), 'utf8'),
    });
  } catch (err) {
    return failed([{ message: `Schematron ${basename(schPath)} could not be loaded: ${describe(err)}` }]);
  }
  try {
    const results = schema.validateString(xml);
    if (results.length === 0) return { valid: true, errors: [] };
    const lines = elementLines(xml);
    return failed(
      results.map((r): ValidationError => {
        const message = collapse(r.message ?? '') || `Schematron ${r.isReport ? 'report' : 'assert'} ${r.assertId ?? '(unnamed)'} fired`;
        const line = lineOf(r.context, lines);
        return {
          ...(line === undefined ? {} : { line }),
          message,
          ...(r.assertId ? { rule: r.assertId } : {}),
        };
      }),
    );
  } catch (err) {
    return failed([{ message: `Schematron validation failed: ${describe(err)}` }]);
  }
}

/** Run the XSD, then the Schematron rules only if the XSD passes. */
export async function validate(xml: string, schemas: SchemaPaths): Promise<ValidationResult> {
  const structural = await validateXsd(xml, schemas.xsd);
  if (!structural.valid || schemas.sch === undefined) return structural;
  return validateSchematron(xml, schemas.sch);
}

function failed(errors: ValidationError[]): ValidationResult {
  return { valid: false, errors };
}

function describe(err: unknown): string {
  return collapse(err instanceof Error ? err.message : String(err));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function siblingSchemas(xsdPath: string): Promise<XMLFileInfo[]> {
  const dir = dirname(xsdPath);
  const self = basename(xsdPath);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.xsd') && n !== self);
  return Promise.all(names.map(async (fileName) => ({ fileName, contents: await readFile(join(dir, fileName), 'utf8') })));
}

function resolveInclude(schPath: string, chain: string[], href: string): string {
  const including = chain.reduce((base, h) => resolve(dirname(base), h), resolve(schPath));
  return resolve(dirname(including), href);
}

// Line numbers for Schematron results. slimdom (node-schematron's DOM) does not record source
// positions, so map the result's context element to its index in document order and look up
// the line of the start tag with the same index in the source. The document already parsed,
// so every `<` outside comments, CDATA, processing instructions, and the doctype that is not
// followed by `/` opens an element.

interface DomNode {
  nodeType: number;
  parentNode: DomNode | null;
  childNodes: ArrayLike<DomNode>;
}

const ELEMENT_NODE = 1;
const MARKUP = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>|<(?=[^\s/!?>])/gi;

function elementLines(xml: string): number[] {
  const lines: number[] = [];
  let line = 1;
  let scanned = 0;
  for (const match of xml.matchAll(MARKUP)) {
    line += countNewlines(xml, scanned, match.index);
    scanned = match.index;
    if (match[0] === '<') lines.push(line);
  }
  return lines;
}

function countNewlines(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function lineOf(context: DomNode, lines: number[]): number | undefined {
  let target: DomNode | null = context;
  while (target && target.nodeType !== ELEMENT_NODE) target = target.parentNode;
  if (!target) return undefined;
  let root: DomNode = target;
  while (root.parentNode) root = root.parentNode;
  let index = -1;
  const visit = (node: DomNode): boolean => {
    if (node.nodeType === ELEMENT_NODE) index++;
    if (node === target) return true;
    return Array.from(node.childNodes).some(visit);
  };
  return visit(root) ? lines[index] : undefined;
}
