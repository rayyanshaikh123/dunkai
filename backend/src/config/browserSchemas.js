// Server-owned response schemas. The browser cannot provide arbitrary schemas,
// tools, provider URLs or executable component code to the inference gateway.
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const array = (items) => ({ type: 'array', items });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const file = object({ filename: string, code: string, description: string });
const schemas = {
  design: object({
    project_name: string, summary: string, requirements: array(string),
    nodes: array(object({ id: string, label: string, category: string })),
    edges: array(object({ source: string, target: string, interface: string })),
    parts: array(object({ ref_id: string, part_class: {type:'string',enum:['resistor','capacitor','inductor','processing','timer','connector','sensor','power','diode','transistor','led','switch','crystal','oscillator','interface','memory','other']}, part_number: nullableString, value: nullableString, package: string, lcsc: nullableString })),
    // One wire format avoids provider ambiguity between overlapping union
    // objects. Exactly one of connections/members is populated; the worker
    // checks that rule and normalizes to the existing PCB IR schemas.
    nets: array(object({ name: string, interface: nullableString, net_class: nullableString, connections: array(string), members: array(object({ ref_id: string, role: string, pin: nullableString })) })),
    unsupported_reasons: array(string),
  }),
  firmware: object({ files: array(file) }),
  revision: object({ reply: string, updated_files: array(file) }),
};

export const browserResponseFormat = (model, purpose) => {
  if (!Object.hasOwn(schemas, purpose)) throw new Error('Unsupported browser inference purpose');
  // Groq documents constrained decoding for these GPT-OSS models. Other
  // configured models use JSON mode and retain the worker's strict validation.
  return ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(model)
    ? { type: 'json_schema', json_schema: { name: `dunkai_${purpose}`, strict: true, schema: schemas[purpose] } }
    : { type: 'json_object' };
};
