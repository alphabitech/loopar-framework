import { loopar, elementsDict } from "loopar";

export const extractElements = (__META__, elements, environment) => {
  let extractedElements = [];
  const ENTITY = __META__.Document.Entity || {};

  const extract = (elements, environment) => {
    for (const el of elements || []) {
      const element = typeof el === "string" ? { element: el } : el;

      const def = elementsDict[element.element]?.def || {};

      if ((environment !== "server" || !def.clientOnly) && (!def.designerOnly || ENTITY.name === "Document")) {
        element.element && extractedElements.push(element.element);

        if (element.elements) {
          extract(element.elements, environment);
        }
      }
    }
  };

  extract(elements, environment);

  return Array.from(new Set(extractedElements));
}

export function requireComponents(__META__) {
  const Document = __META__.Document || {};
  const Entity = Document.Entity || {};
  const action = ["update", "create", "form"].includes(Document.meta.action) ? "form" : Document.meta.action;

  const filterByWritable = (structure) => {
    return structure.reduce((acc, element) => {
      if (loopar.utils.trueValue(element.data?.searchable)) {
        acc.push(element);
      }

      if (element.elements) {
        acc.push(...filterByWritable(element.elements));
      }

      return acc;
    }, []);
  }

  const data = Document.data || {};

  const entityDocStructure = loopar.utils.JSONparse(Entity.doc_structure, []);
  const documentDocStructure = loopar.utils.JSONparse(data.doc_structure, []);
  const printDocStructure = loopar.utils.JSONparse(Document.print?.format?.doc_structure, []);

  if (action === "list") {
    return [
      ...filterByWritable(Array.isArray(entityDocStructure) ? entityDocStructure : []),
      ...filterByWritable(Array.isArray(documentDocStructure) ? documentDocStructure : [])
    ];
  } else {
    return [
      ...(Array.isArray(entityDocStructure) ? entityDocStructure : []),
      ...(Array.isArray(documentDocStructure) ? documentDocStructure : []),
      ...(Array.isArray(printDocStructure) ? printDocStructure : []),
    ];
  }
}

export function MetaComponents(__META__, environment) {
  return extractElements(__META__, requireComponents(__META__), environment);
}