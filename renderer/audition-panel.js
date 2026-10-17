/**
 * DOM for the morph audition layer: one slider per PMX morph, grouped by
 * PMX panel, a sweep through every morph, and saved candidate combinations
 * that export as expressions.json entries.
 *
 * Morph names come from the PMX file, so they are only ever set as text.
 */

import { PANELS } from "./morph-audition.js";

const CANDIDATE_STORAGE_KEY = "yidhari.morph-candidates";
const SWEEP_INTERVAL = 1.5;

/**
 * @typedef {object} MorphRow
 * @property {import("./morph-audition.js").MorphInfo} morph Morph shown by this row.
 * @property {HTMLElement} element Row container.
 * @property {HTMLInputElement} input Manual weight slider.
 * @property {HTMLOutputElement} output Manual weight readout.
 * @property {HTMLElement} bar Final influence bar.
 * @property {string} searchText Lowercase text matched by the filter.
 * @property {number} manual Last manual weight drawn.
 * @property {number} live Last final influence drawn.
 */

/**
 * @typedef {object} Candidate
 * @property {string} name Kebab-case semantic name.
 * @property {Record<string, number>} morphs PMX morph names and weights.
 */

/**
 * Create an element with a class name and optional text content.
 * @param {string} tag Element tag name.
 * @param {string} [className] Class attribute.
 * @param {string} [text] Text content.
 * @returns {HTMLElement} New element.
 */
function make(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text) {
    element.textContent = text;
  }
  return element;
}

/**
 * Turn a typed candidate name into a catalog-friendly kebab-case key.
 * @param {string} name Name typed by the user.
 * @returns {string} Normalized name, empty if nothing usable remains.
 */
function normalizeName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Describe a morph combination in one short line.
 * @param {Record<string, number>} morphs PMX morph names and weights.
 * @returns {string} Combination such as "にこり 0.6 + 口角上げ 0.4".
 */
function describeMorphs(morphs) {
  return Object.entries(morphs).map(([name, weight]) => `${name} ${weight}`).join(" + ");
}

/**
 * Format candidates as JSON entries to merge into expressions.json.
 * @param {Candidate[]} candidates Saved candidates.
 * @returns {string} JSON object containing candidate entries.
 */
function toCatalogSource(candidates) {
  return JSON.stringify(Object.fromEntries(candidates.map(({ name, morphs }) => [
    name, { description: "TODO: Describe when to use this expression.", morphs },
  ])), null, 2);
}

export class AuditionPanel {
  /**
   * @param {import("./morph-audition.js").MorphAudition} audition Manual morph layer.
   * @param {object} options Panel wiring.
   * @param {Map<string, string[]>} options.usage Presets and channels that drive each morph.
   * @param {() => void} options.onManualEdit Called when a slider moves.
   * @param {() => void} options.onTakeover Called when a sweep or candidate replaces the face.
   */
  constructor(audition, { usage, onManualEdit, onTakeover }) {
    this.audition = audition;
    this.usage = usage;
    this.onManualEdit = onManualEdit;
    this.onTakeover = onTakeover;
    /** @type {MorphRow[]} */
    this.rows = [];
    this.sweepMorph = null;
    this.candidates = this.loadCandidates();

    this.groups = document.querySelector("#morph-groups");
    this.search = document.querySelector("#morph-search");
    this.sweepButton = document.querySelector("#sweep-button");
    this.sweepStatus = document.querySelector("#sweep-status");
    this.resetButton = document.querySelector("#reset-morphs-button");
    this.candidateName = document.querySelector("#candidate-name");
    this.saveButton = document.querySelector("#save-candidate-button");
    this.candidateList = document.querySelector("#candidate-list");
    this.candidateStatus = document.querySelector("#candidate-status");
    this.exportButton = document.querySelector("#export-candidates-button");
    this.exportText = document.querySelector("#candidate-export");

    this.buildGroups();
    this.renderCandidates();

    this.search.addEventListener("input", () => this.applyFilter());
    this.sweepButton.addEventListener("click", () => this.toggleSweep());
    this.resetButton.addEventListener("click", () => this.audition.clear());
    this.saveButton.addEventListener("click", () => this.saveCandidate());
    this.candidateName.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.saveCandidate();
      }
    });
    this.exportButton.addEventListener("click", () => this.exportCandidates());

    for (const control of [this.search, this.sweepButton, this.resetButton,
      this.candidateName, this.saveButton, this.exportButton]) {
      control.disabled = false;
    }
  }

  /**
   * Build one collapsible group of sliders per PMX panel.
   * @returns {void}
   */
  buildGroups() {
    this.groups.replaceChildren();
    for (const panel of PANELS) {
      const morphs = this.audition.inventory.filter((morph) => morph.panel === panel.id);
      if (morphs.length === 0) {
        continue;
      }
      const group = make("details", "morph-group");
      group.open = true;
      group.append(make("summary", "", `${panel.label} · ${morphs.length}`));
      for (const morph of morphs) {
        group.append(this.buildRow(morph));
      }
      this.groups.append(group);
    }
  }

  /**
   * Build the slider row for one morph.
   * @param {import("./morph-audition.js").MorphInfo} morph Morph to control.
   * @returns {HTMLElement} Row element.
   */
  buildRow(morph) {
    const id = `morph-${morph.index}`;
    const used = this.usage.get(morph.name) ?? [];
    const element = make("div", "morph-row");

    const label = make("label", "morph-label");
    label.htmlFor = id;
    label.append(make("span", "morph-name", morph.name));
    if (morph.romaji) {
      label.append(make("span", "morph-romaji", morph.romaji));
    }
    label.append(make("span", "morph-english", morph.englishName));
    element.append(label);

    if (used.length > 0) {
      element.append(make("span", "morph-usage", used.join(" · ")));
    }

    const input = /** @type {HTMLInputElement} */ (make("input"));
    input.type = "range";
    input.id = id;
    input.min = "0";
    input.max = "1";
    input.step = "0.05";
    input.value = "0";
    input.addEventListener("input", () => {
      this.audition.stopSweep();
      this.audition.setWeight(morph.name, Number(input.value));
      this.onManualEdit();
    });
    input.addEventListener("dblclick", () => {
      this.audition.setWeight(morph.name, 0);
    });

    const output = /** @type {HTMLOutputElement} */ (make("output", "morph-value", "0.00"));
    output.htmlFor.add(id);

    const bar = make("div", "morph-live");
    bar.setAttribute("aria-hidden", "true");

    element.append(input, output, bar);
    this.rows.push({
      morph,
      element,
      input,
      output,
      bar,
      searchText: [morph.name, morph.romaji, morph.englishName, ...used].join(" ").toLowerCase(),
      manual: 0,
      live: -1,
    });
    return element;
  }

  /**
   * Hide rows that do not match the filter text.
   * @returns {void}
   */
  applyFilter() {
    const query = this.search.value.trim().toLowerCase();
    for (const row of this.rows) {
      row.element.hidden = query !== "" && !row.searchText.includes(query);
    }
  }

  /**
   * Start or stop stepping through every morph on its own.
   * @returns {void}
   */
  toggleSweep() {
    if (this.audition.sweeping) {
      this.audition.stopSweep();
      return;
    }
    if (this.audition.startSweep(SWEEP_INTERVAL, 1)) {
      this.onTakeover();
    }
  }

  /**
   * Sync sliders, influence bars, and sweep state with the current frame.
   * Only touches the DOM where a value changed.
   * @returns {void}
   */
  refresh() {
    const influences = this.audition.mesh.morphTargetInfluences;
    for (const row of this.rows) {
      const manual = this.audition.getWeight(row.morph.name);
      if (manual !== row.manual) {
        row.manual = manual;
        row.input.value = String(manual);
        row.output.value = manual.toFixed(2);
        row.element.classList.toggle("is-set", manual > 0);
      }
      const live = Math.round(influences[row.morph.index] * 100) / 100;
      if (live !== row.live) {
        row.live = live;
        row.bar.style.setProperty("--live", String(live));
      }
    }

    const sweepMorph = this.audition.getSweepMorph();
    if (sweepMorph !== this.sweepMorph) {
      this.sweepMorph = sweepMorph;
      for (const row of this.rows) {
        const current = row.morph.name === sweepMorph;
        row.element.classList.toggle("is-sweeping", current);
        if (current && !row.element.hidden) {
          row.element.scrollIntoView({ block: "nearest" });
        }
      }
      if (sweepMorph) {
        const morph = this.audition.byName.get(sweepMorph);
        const position = this.audition.sweepPosition + 1;
        this.sweepStatus.textContent = `Sweeping ${position}/${this.audition.inventory.length} · ` +
          `${morph.name}${morph.romaji ? ` (${morph.romaji})` : ""} · ${morph.englishName}`;
      } else {
        this.sweepStatus.textContent = "";
      }
      this.sweepButton.setAttribute("aria-pressed", String(sweepMorph !== null));
      this.sweepButton.textContent = sweepMorph ? "⏸ sweep" : "▶ sweep";
    }
  }

  /**
   * Read saved candidates. Storage can be blocked, so failures mean none.
   * @returns {Candidate[]} Saved candidates.
   */
  loadCandidates() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CANDIDATE_STORAGE_KEY) ?? "[]");
      return Array.isArray(parsed)
        ? parsed.filter((candidate) => typeof candidate?.name === "string" &&
          candidate.morphs && typeof candidate.morphs === "object")
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Persist candidates in this browser. Failure only loses the convenience.
   * @returns {void}
   */
  storeCandidates() {
    try {
      localStorage.setItem(CANDIDATE_STORAGE_KEY, JSON.stringify(this.candidates));
    } catch {
      this.candidateStatus.textContent = "Browser storage is unavailable; candidates last until reload.";
    }
  }

  /**
   * Save the current sliders as a named candidate, replacing one of the same name.
   * @returns {void}
   */
  saveCandidate() {
    const name = normalizeName(this.candidateName.value);
    const morphs = this.audition.getActiveMorphs();
    if (!name) {
      this.candidateStatus.textContent = "Name the candidate first, e.g. soft-smile.";
      return;
    }
    if (Object.keys(morphs).length === 0) {
      this.candidateStatus.textContent = "Move at least one slider before saving.";
      return;
    }
    const existing = this.candidates.findIndex((candidate) => candidate.name === name);
    if (existing >= 0) {
      this.candidates[existing] = { name, morphs };
    } else {
      this.candidates.push({ name, morphs });
    }
    this.storeCandidates();
    this.renderCandidates();
    this.candidateName.value = "";
    this.candidateStatus.textContent = `Saved ${name}.`;
  }

  /**
   * Show each saved candidate with load and delete buttons.
   * @returns {void}
   */
  renderCandidates() {
    this.candidateList.replaceChildren();
    for (const candidate of this.candidates) {
      const item = make("li", "candidate");
      const load = make("button", "candidate-load");
      load.type = "button";
      load.append(make("strong", "", candidate.name), make("span", "", describeMorphs(candidate.morphs)));
      load.addEventListener("click", () => this.loadCandidate(candidate));
      const remove = make("button", "candidate-delete", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Delete ${candidate.name}`);
      remove.addEventListener("click", () => this.deleteCandidate(candidate.name));
      item.append(load, remove);
      this.candidateList.append(item);
    }
    this.exportButton.hidden = this.candidates.length === 0;
  }

  /**
   * Replace the sliders with a saved candidate.
   * @param {Candidate} candidate Candidate to preview.
   * @returns {void}
   */
  loadCandidate(candidate) {
    this.audition.clear();
    const missing = this.audition.setWeights(candidate.morphs);
    this.onTakeover();
    this.candidateName.value = candidate.name;
    this.candidateStatus.textContent = missing.length > 0
      ? `Loaded ${candidate.name}; missing on this model: ${missing.join(", ")}`
      : `Loaded ${candidate.name}.`;
  }

  /**
   * Remove one saved candidate.
   * @param {string} name Candidate name.
   * @returns {void}
   */
  deleteCandidate(name) {
    this.candidates = this.candidates.filter((candidate) => candidate.name !== name);
    this.storeCandidates();
    this.renderCandidates();
    this.candidateStatus.textContent = `Deleted ${name}.`;
  }

  /**
   * Show every candidate as catalog source and copy it to the clipboard.
   * @returns {Promise<void>}
   */
  async exportCandidates() {
    const source = toCatalogSource(this.candidates);
    this.exportText.value = source;
    this.exportText.hidden = false;
    this.exportText.select();
    try {
      await navigator.clipboard.writeText(source);
      this.candidateStatus.textContent = "Copied. Fill in descriptions and merge entries into expressions.json after a neutral-transition check.";
    } catch {
      this.candidateStatus.textContent = "Clipboard unavailable; copy the selected text instead.";
    }
  }
}
