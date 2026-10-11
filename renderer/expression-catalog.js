/**
 * Semantic mood names and their PMX morph weights.
 * Each entry describes one exclusive mood; neutral is handled by the controller.
 * @type {Record<string, { morphs: Record<string, number> }>}
 */
export const EXPRESSION_CATALOG = {
  happy: { morphs: { "笑い": 1 } },
  surprised: { morphs: { "びっくり": 1 } },
  thinking: { morphs: { "じと目": 1 } },
  troubled: { morphs: { "困る": 1 } },
  angry: { morphs: { "怒り": 1, "怒り目": 1 } },
};
