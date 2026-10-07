// Server-owned response schemas. The browser cannot provide arbitrary schemas,
// tools, provider URLs or executable component code to the inference gateway.
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const array = (items) => ({ type: 'array', items });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const file = object({ filename: string, code: string, description: string });
const requirements = object({project_name:nullableString,category:nullableString,objective:nullableString,
  target_users:{type:['array','null'],items:string},functional_requirements:{type:['array','null'],items:string},
  hardware_inputs:{type:['array','null'],items:string},hardware_outputs:{type:['array','null'],items:string},connectivity:{type:['array','null'],items:string},
  supported_platforms:{type:['array','null'],items:string},power_requirements:nullableString,physical_constraints:{type:['array','null'],items:string},
  performance_requirements:{type:['array','null'],items:string},safety_compliance:{type:['array','null'],items:string},budget:nullableString});
const schemas = {
  interview:object({status:{type:'string',enum:['question','complete']},question:nullableString,options:array(string),requirements:{...requirements,type:['object','null']}}),
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

/** Keep JSON-mode models and older browser prompts aligned with the same
 * server-owned wire format. Nullable fields are required, not optional. */
export const browserSchemaInstruction = (purpose) => {
  if (!Object.hasOwn(schemas, purpose)) throw new Error('Unsupported browser inference purpose');
  return `Return one JSON object matching this schema exactly. Include every required field, use null for unknown nullable strings, and use only the listed enum values. Do not add fields or markdown.\n${JSON.stringify(schemas[purpose])}`
    + (purpose === 'design'
      ? '\nUse confirmed power, budget and build-type requirements. part_number must be a real manufacturer number, never an LCSC code or a generic description such as USB-C-TYPE-A-RECEPTACLE. C14877 belongs in lcsc; its manufacturer number is ATMEGA328P-AU and package TQFP-32. External modules such as HC-SR04 require a verified module footprint or an exact connector for a carrier PCB; describe external wiring without claiming the module is a bare IC. For every net include both connections and members arrays; populate exactly one with at least two endpoints. Explicit connections use interface:null. Role-based nets MUST set a non-null interface (Power, I2C, SPI, UART, GPIO, ADC, PWM, USB, CAN, OneWire, I2S or SDIO). Put only the role in member.role: e.g. interface:"I2C",role:"CLOCK", never role:"I2C CLOCK". GPIO and PWM roles use interface:"GPIO" and interface:"PWM", respectively. Every member includes pin:null unless a verified manufacturer pin label is known. Power and ground are nets, not imaginary physical parts. A physical power connector uses part_class:connector and an exact manufacturer part number. Never invent parts or pins to satisfy the schema.'
      : '');
};
