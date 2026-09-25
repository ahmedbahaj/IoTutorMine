/**
 * Eligibility and result validation.
 *
 * Two distinct jobs:
 *  1. assessRelevance() - a cheap, pre-Gemini signal so obviously unrelated
 *     content never reaches the model. Deliberately conservative: it only
 *     rejects when both the metadata and the transcript are devoid of any
 *     hardware signal. Anything ambiguous is returned as "uncertain" and is
 *     allowed through.
 *  2. validateComponents() / assessPublication() - post-extraction schema and
 *     publication checks. These decide whether a result is fit to appear in the
 *     shared library. They do NOT assert that the extraction is correct.
 */

export const VALID_STATUSES = ["USED", "ALTERNATIVE"];

export const MAX_COMPONENT_NAME_LENGTH = 120;
export const MAX_COMPONENTS = 200;

/** Hardware nouns: boards, sensors, actuators, passives, connectors. */
const HARDWARE_TERMS = [
  "arduino", "esp32", "esp8266", "nodemcu", "raspberry pi", "pi pico", "rp2040",
  "stm32", "attiny", "atmega", "microcontroller", "micro controller", "dev board",
  "development board", "breadboard", "perfboard", "pcb", "jumper wire", "jumper wires",
  "dupont", "breakout board", "shield", "hat module",
  "sensor", "dht11", "dht22", "bme280", "bmp180", "ds18b20", "mpu6050", "hc-sr04",
  "ultrasonic", "pir", "ldr", "photoresistor", "thermistor", "potentiometer",
  "accelerometer", "gyroscope", "load cell", "hall effect", "ir receiver",
  "servo", "stepper motor", "dc motor", "motor driver", "l298n", "a4988", "relay",
  "solenoid", "buzzer", "piezo", "actuator", "pump",
  "resistor", "capacitor", "transistor", "mosfet", "diode", "led", "rgb led",
  "neopixel", "ws2812", "seven segment", "oled", "lcd", "tft", "e-ink", "display",
  "voltage regulator", "buck converter", "boost converter", "power supply",
  "battery", "lipo", "18650", "solar panel",
  "soldering", "solder", "multimeter", "oscilloscope", "logic analyzer",
  "gpio", "i2c", "spi", "uart", "pwm", "analog pin", "digital pin", "pinout",
  "wiring", "circuit", "schematic", "datasheet", "header pins", "terminal block",
  "lora", "nrf24", "bluetooth module", "hc-05", "wifi module", "sim800", "rfid",
  "rc522", "esp-now", "zigbee", "mqtt", "home assistant", "esphome"
];

/** Words indicating instructional hardware content rather than a talking-head video. */
const TUTORIAL_TERMS = [
  "tutorial", "how to", "howto", "guide", "diy", "build", "project", "wiring",
  "getting started", "beginner", "step by step", "make", "hack", "workshop",
  "connect", "setup", "assemble", "solder"
];

function countTerms(haystack, terms) {
  if (!haystack) return { hits: 0, matched: [] };
  const text = ` ${String(haystack).toLowerCase()} `;
  const matched = [];
  for (const term of terms) {
    if (text.includes(term)) matched.push(term);
  }
  return { hits: matched.length, matched };
}

/**
 * Cheap pre-model eligibility signal.
 *
 * @returns {{verdict:'eligible'|'uncertain'|'rejected', reason:string|null, signals:object}}
 */
export function assessRelevance({ title = "", author = "", transcript = "" } = {}) {
  const text = String(transcript || "");
  const metadata = countTerms(`${title} ${author}`, HARDWARE_TERMS);
  const tutorial = countTerms(`${title} ${text.slice(0, 4000)}`, TUTORIAL_TERMS);
  const body = countTerms(text, HARDWARE_TERMS);

  const signals = {
    metadataHits: metadata.hits,
    transcriptHits: body.hits,
    tutorialHits: tutorial.hits,
    matched: [...new Set([...metadata.matched, ...body.matched])].slice(0, 12)
  };

  const haveTranscript = text.trim().length > 0;

  // Strong signal: several distinct hardware terms in the spoken content.
  if (body.hits >= 3) return { verdict: "eligible", reason: null, signals };

  // Metadata alone never decides, but a clear hardware title plus any
  // transcript support is sufficient.
  if (metadata.hits >= 2 && body.hits >= 1) {
    return { verdict: "eligible", reason: null, signals };
  }

  // Reject only when we actually inspected substantial spoken content and found
  // no hardware vocabulary at all, in either the transcript or the metadata.
  if (haveTranscript && text.length >= 400 && body.hits === 0 && metadata.hits === 0) {
    return {
      verdict: "rejected",
      reason: "This video does not appear to be an IoT hardware tutorial.",
      signals
    };
  }

  // Short transcripts, unusual titles, missing metadata: let the model decide,
  // but record that eligibility was not established up front.
  return { verdict: "uncertain", reason: null, signals };
}

function normaliseStatus(status) {
  const value = String(status || "").trim().toUpperCase();
  return VALID_STATUSES.includes(value) ? value : null;
}

/**
 * Validate and normalise the model's component list.
 * Preserves the existing USED / ALTERNATIVE classification and the
 * `alternativeTo` linkage used by the catalog UI.
 */
export function validateComponents(raw) {
  const errors = [];

  if (!Array.isArray(raw)) {
    return { ok: false, components: [], errors: ["Response did not contain a component array."] };
  }

  const seen = new Set();
  const components = [];

  for (const entry of raw.slice(0, MAX_COMPONENTS)) {
    if (!entry || typeof entry !== "object") continue;

    const name = String(entry.name ?? "").replace(/\s+/g, " ").trim();
    if (!name || name.length > MAX_COMPONENT_NAME_LENGTH) continue;

    const status = normaliseStatus(entry.status);
    if (!status) continue;

    const key = `${name.toLowerCase()}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const component = { name, status };

    const altTo = String(entry.alternativeTo ?? "").replace(/\s+/g, " ").trim();
    if (status === "ALTERNATIVE" && altTo && altTo.length <= MAX_COMPONENT_NAME_LENGTH) {
      component.alternativeTo = altTo;
    }

    components.push(component);
  }

  if (!components.length) errors.push("No valid components were returned.");

  return { ok: components.length > 0, components, errors };
}

export function countUsed(components) {
  return (components || []).filter(c => c.status === "USED").length;
}

/**
 * Decide whether a validated result may appear in the shared public library.
 *
 * Publication is intentionally narrow. A published row is an *extracted result*,
 * not verified ground truth, and the status is stored so entries can later be
 * hidden or rejected.
 */
export function assessPublication({ source, components, relevance, metadataAvailable, title }) {
  // Manually pasted transcripts are never auto-published: we cannot establish
  // that the pasted text actually corresponds to the linked video.
  if (source === "manual-transcript") {
    return { publish: false, status: "pending", reason: "manual-transcript-unverified" };
  }

  if (!Array.isArray(components) || components.length === 0) {
    return { publish: false, status: "rejected", reason: "no-components" };
  }

  if (relevance === "rejected") {
    return { publish: false, status: "rejected", reason: "not-iot-hardware" };
  }

  if (countUsed(components) < 1) {
    return { publish: false, status: "rejected", reason: "no-used-components" };
  }

  if (metadataAvailable !== true || !title) {
    return { publish: false, status: "pending", reason: "video-metadata-unavailable" };
  }

  // Eligibility was uncertain up front. A single lone component does not
  // resolve that ambiguity, so the entry is held back for review.
  if (relevance === "uncertain" && components.length < 2) {
    return { publish: false, status: "pending", reason: "eligibility-uncertain" };
  }

  return { publish: true, status: "published", reason: null };
}

/** Flat, lowercase haystack used for shared-library search (title + part names). */
export function buildSearchText({ title, author, components }) {
  const parts = [title || "", author || ""];
  for (const c of components || []) {
    parts.push(c.name || "");
    if (c.alternativeTo) parts.push(c.alternativeTo);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 4000);
}
