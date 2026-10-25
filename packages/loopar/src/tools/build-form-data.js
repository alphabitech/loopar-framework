export function buildFormData(values = {}) {
  const formData = new FormData();

  for (const [key, value] of Object.entries(values)) {
    if (key === "__FILES__") {
      for (const file of value || []) {
        if (file instanceof File) formData.append("files[]", file);
      }
      continue;
    }

    if (Array.isArray(value) && value.some(v => v?.rawFile instanceof File)) {
      const meta = [];
      for (const item of value) {
        if (item?.rawFile instanceof File) {
          formData.append("files[]", item.rawFile);
          meta.push({
            name: item.rawFile.name,
            size: item.rawFile.size,
            type: item.rawFile.type,
          });
        } else {
          meta.push(item);
        }
      }
      formData.append(key, JSON.stringify(meta));
      continue;
    }

    // Date pickers hold Date objects: JSON.stringify would wrap the ISO
    // string in quotes ('"2026-10-23T…Z"'), which the server can't parse.
    if (value instanceof Date) {
      formData.append(key, isNaN(value.getTime()) ? "" : value.toISOString());
      continue;
    }

    if (value !== null && typeof value === "object") {
      formData.append(key, JSON.stringify(value));
      continue;
    }

    formData.append(key, value ?? "");
  }

  return formData;
}
