
'use strict';

import { BaseDocument, loopar, AIPrompt, AIStructureSchema, sanitizeAIStructure, Helpers } from 'loopar';
import OpenAI from "openai";

export default class AI extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async getSettings() {
    !this.ai_model && loopar.throw(`Please select an AI Model in <a href="/desk/AI/update">AI Settings</a>`);

    const model = await loopar.getDocument("AI Model", this.ai_model);

    !model.ai_provider && loopar.throw(`Please set the Provider in the AI Model <a href="/desk/AI Model/update?name=${this.ai_model}">${this.ai_model}</a>`);

    const provider = await loopar.getDocument("AI Provider", model.ai_provider);

    !provider.api_key && loopar.throw(`Please set the API key in the AI Provider <a href="/desk/AI Provider/update?name=${model.ai_provider}">${model.ai_provider}</a>`);

    const attributes = await loopar.db.getAll("AI Attribute", ["attribute", "value"], {
      parent_id: await model.__ID__(),
      parent_document: "AI Model"
    });

    // AI Attribute rows -> request params, numeric when possible
    const params = {};
    for (const { attribute, value } of attributes) {
      if (!attribute || value == null || value === "") continue;
      params[attribute] = isNaN(value) ? value : Number(value);
    }

    return {
      model: model.model_id || model.name,
      apiKey: provider.api_key,
      baseURL: provider.base_url || undefined,
      params
    };
  }

  /**
   * One chat completion that must answer JSON, with the degradation ladder
   * every caller needs: strict json_schema (OpenAI, Ollama) → json_object
   * (DeepSeek) → unconstrained. chat.completions is the surface every
   * OpenAI-compatible provider implements; /responses is OpenAI-only.
   * Returns the raw text of the answer (callers parse it tolerantly).
   */
  async completeJSON({ system, user, schema = null, name = "response" }) {
    const { model, apiKey, baseURL, params } = await this.getSettings();
    const client = new OpenAI({ apiKey, baseURL });
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user }
    ];

    const call = (extra = {}) => client.chat.completions.create({ model, messages, ...extra, ...params });

    let response;
    try {
      response = schema
        ? await call({ response_format: { type: "json_schema", json_schema: { name, schema, strict: true } } })
        : await call({ response_format: { type: "json_object" } });
    } catch (error) {
      console.warn("AI: provider rejected the structured format, trying json_object:", error.message);
      try {
        response = await call({ response_format: { type: "json_object" } });
      } catch (error2) {
        console.warn("AI: provider rejected json_object, unconstrained call:", error2.message);
        response = await call();
      }
    }

    return response.choices[0].message.content || "";
  }

  async prompt(data) {
    const { prompt, document_type } = data;
    const current = loopar.utils.isJSON(data.current) ? JSON.parse(data.current) : null;
    const p = AIPrompt(prompt, document_type, current);
    const format = AIStructureSchema(document_type);

    const content = await this.completeJSON({
      system: p.system.content,
      user: p.user.content,
      schema: format.schema,
      name: format.name,
    });

    let elements;
    try {
      const parsed = JSON.parse(content);
      elements = Array.isArray(parsed) ? parsed : parsed.elements || [];
    } catch {
      elements = Helpers.evaluateAIResponse(content, "[", "]");
    }

    return JSON.stringify(sanitizeAIStructure(elements));
  }
}
