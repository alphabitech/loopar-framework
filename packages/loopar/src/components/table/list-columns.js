/** Entity `title_fields` ("first_name, last_name") as a list of field names. */
export const titleFieldsOf = (Entity) =>
  String(Entity?.title_fields || "").split(",").map((s) => s.trim()).filter(Boolean);
