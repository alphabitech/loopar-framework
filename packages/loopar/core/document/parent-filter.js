'use strict';

import { loopar } from "../loopar.js";
import * as pure from "../global/parent-filter.js";

/** Cascades and directory filters bound to the tenant's refs (global/parent-filter.js). */
const getRef = (name) => loopar.getRef(name, false);

export const parseFilters = pure.parseFilters;
export const inferParentFilter = (args) => pure.inferParentFilter(args, getRef);
export const findFieldMeta = (entity, name) => pure.findFieldMeta(entity, name, getRef);
