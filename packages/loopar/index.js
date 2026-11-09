
import BaseDocument from "./core/document/base-document.js";
import BaseStorage from "./core/document/base-storage.js";
import {
  loopar,
  startCore,
  getOrCreateTenantInstance,
  getTenantInstance,
  evictTenantInstance,
} from "./core/loopar.js";
import { tenantRegistry } from "./core/server/tenant-registry.js";
import {
  StorageDriver,
  LocalDriver,
  CloudinaryDriver,
} from "./core/global/storage/index.js";
import { documentManage } from "./core/document/document-manage.js";
import { fileManage } from "./core/file-manage.js";
import fileManager from "./core/global/file-manager.js";
import ContactFormBase from "./core/document/contact-form-base.js";
import { namingSeriesError } from "./core/document/naming-series.js";
import { invalidateWorkflows, workflowFor, applyTransition, backfillInitialState } from "./core/document/workflow.js";
import BaseContactFormController from "./core/controller/base-contact-form-controller.js";
import BaseController from "./core/controller/base-controller.js";
import SingleController from "./core/controller/single-controller.js";
import PageController from "./core/controller/page-controller.js";
import ViewController from "./core/controller/view-controller.js";
import ReportController from "./core/controller/report-controller.js";
import FormController from "./core/controller/form-controller.js";
import PrintFormatController from "./core/controller/print-format-controller.js";
import DeskPageController from "./core/controller/desk-page-controller.js";
import { listDeskPages, deskHomes } from "./core/document/desk-page.js";
import { chartData, getChart, dashboardItems, dashboardItemData, sidebarDashboards } from "./core/document/dashboard-data.js";
import { listPrintFormats, getPrintFormat, getLetterhead } from "./core/document/print-format.js";
import { getCompany, companyBrand, formatAddress, colorToHex } from "./core/global/company.js";
import SystemController from "./apps/core/modules/system/controllers/system/system-controller.js";
import CoreInstaller from "./apps/core/modules/system/forms/installer/installer.js";
import * as Helpers from "./core/global/helper.js";
import { getRequest, getResponse, requestContext } from "./core/server/router/request-context.js";
import {
  elementsNames,
  elementsNameByType,
  elementsDict,
  AIPrompt,
  AIStructureSchema,
  sanitizeAIStructure,
  TYPES,
  COLUMN_FORMAT,
  COLUMN_FORMATS,
  LEGACY_TAG_TO_FORMAT,
  resolveColumnFormat,
  registerColumnFormat,
} from "./core/global/element-definition.js";
import { MetaComponents } from "./core/global/require-components.js";
export {themes, showColors} from "./core/global/themes.js";
export {generateThemeCSS, normalizeBrand, COMPANY_THEME} from "./core/global/theme-generator.js";
export {
  portalIdentity,
  requirePortalIdentity,
  forgetPortalIdentity,
  customerCondition,
  customerFieldOf,
  isCustomerRecord,
  CUSTOMER_ENTITY,
  CONTACT_ENTITY,
  CONTACT_LINK_ENTITY,
  CUSTOMER_FIELD,
} from "./core/auth/customer-scope.js";
export { SCOPE, normalizeScope } from "./core/auth/PermissionManager.js";
export { sanitizeInput, trustedInput, isTrustedInput, policyMapOf, currentActor, lockStructure } from "./core/auth/field-access.js";
export { WRITE_POLICY, writePolicyMap, filterInput } from "./core/global/field-policy.js";
export { markStepUp, hasFreshStepUp, clearStepUp, requireStepUp, stepUpLocked, registerStepUpFailure, markOauthProof, takeOauthProof, STEP_UP_REQUIRED_CODE } from "./core/auth/step-up.js";
export { connectionFromInstallData } from "./core/global/install-connection.js";
export {
  __,
  interpolate,
  currentLanguage,
  normalizeLanguage,
  baseLanguage,
  languageName,
  languageOptions,
  parseLanguageList,
  LANGUAGE_NAMES,
  DEFAULT_LANGUAGE,
} from "./core/global/i18n.js";
export {
  getMessages,
  availableLanguages,
  browserLanguage,
  withLanguage,
  siteLanguages,
  siteDefaultLanguage,
  requestLanguage,
  setLanguageCookie,
  invalidateTranslations,
  clientI18nPayload,
  LANGUAGE_COOKIE,
  translateRecord,
  translateRecords,
  contentLanguages,
  loadRegional,
  invalidateRegional,
  regionalFor,
} from "./core/server/i18n.js";
export {
  formatNumber,
  formatCurrency,
  formatDate,
  formatTime,
  formatDateTime,
  countryName as localizedCountryName,
} from "./core/global/format.js";
export {
  applyContentLayer,
  applyRecordLayer,
  contentTexts,
  translationLayer,
} from "./core/global/i18n-content.js";
import { parseDocument } from './core/document/tools.js';
import {
  pruneDocStructure,
  getNodeKey
} from './core/global/prune-doc-structure.js';
import {PermissionManager} from './core/auth/PermissionManager.js'
import {tenant} from './bin/tenant/tenant-builder.js';
import { ActionScanner } from "./core/auth/ActionScanner.js";
import { Op, opByDescription, isOpSymbol } from 'db-env';
import { debugCollector, DEBUG_LIMITS } from "./core/debug/collector.js";
import { frameworkStatus } from "./core/debug/status.js";
import { testRuns, listTestFiles, testsAllowed, TEST_SUITES } from "./core/debug/test-runner.js";

import {
  DOC_STATUS,
  DOC_STATUS_LABEL,
  AUDIT_COLUMN_NAMES,
  AUDIT_COLUMN_SET,
  AUDIT_COLUMN_FAMILY,
  CREATED_BY_COLUMN,
  CHILD_POSITION_COLUMN,
  orderChildRows,
  CREATED_BY_LENGTH,
  FRAMEWORK_OWNED_COLUMN_NAMES,
  FRAMEWORK_OWNED_COLUMN_SET,
  coerceDocStatus,
  isAuditableEntity,
  addAuditColumns,
  addPrimaryKey,
} from './core/global/audit.js';

export {
  loopar,
  startCore,
  getOrCreateTenantInstance,
  getTenantInstance,
  evictTenantInstance,
  tenantRegistry,
  documentManage,
  BaseDocument,
  BaseStorage,
  ContactFormBase,
  namingSeriesError,
  invalidateWorkflows,
  workflowFor,
  applyTransition,
  backfillInitialState,
  BaseContactFormController,
  StorageDriver,
  LocalDriver,
  CloudinaryDriver,
  BaseController,
  SystemController,
  SingleController,
  PageController,
  ViewController,
  ReportController,
  FormController,
  PrintFormatController,
  DeskPageController,
  listDeskPages,
  deskHomes,
  chartData,
  getChart,
  dashboardItems,
  dashboardItemData,
  sidebarDashboards,
  listPrintFormats,
  getPrintFormat,
  getLetterhead,
  getCompany,
  companyBrand,
  formatAddress,
  colorToHex,
  fileManage,
  fileManager,
  Helpers,
  elementsNames,
  elementsNameByType,
  elementsDict,
  MetaComponents,
  CoreInstaller,
  AIPrompt,
  AIStructureSchema,
  sanitizeAIStructure,
  parseDocument,
  TYPES,
  COLUMN_FORMAT,
  COLUMN_FORMATS,
  LEGACY_TAG_TO_FORMAT,
  resolveColumnFormat,
  registerColumnFormat,
  PermissionManager,
  tenant,
  ActionScanner,
  pruneDocStructure,
  getNodeKey,
  Op,
  opByDescription,
  isOpSymbol,
  DOC_STATUS,
  DOC_STATUS_LABEL,
  AUDIT_COLUMN_NAMES,
  AUDIT_COLUMN_SET,
  AUDIT_COLUMN_FAMILY,
  CREATED_BY_COLUMN,
  CHILD_POSITION_COLUMN,
  orderChildRows,
  CREATED_BY_LENGTH,
  FRAMEWORK_OWNED_COLUMN_NAMES,
  FRAMEWORK_OWNED_COLUMN_SET,
  coerceDocStatus,
  isAuditableEntity,
  addAuditColumns,
  addPrimaryKey,
  getRequest,
  // Debugger (core/debug): collector, status snapshot, test runs.
  debugCollector,
  DEBUG_LIMITS,
  frameworkStatus,
  testRuns,
  listTestFiles,
  testsAllowed,
  TEST_SUITES,
  // Run code as a tenant outside an HTTP request (tests, scripts):
  //   requestContext.run({ tenant: { name } }, fn)
  requestContext,
  getResponse
};