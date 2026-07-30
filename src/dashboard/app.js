"use strict";

const DASHBOARD_CONFIG = window.DASHBOARD_CONFIG || {};

const AVAILABLE_LANGUAGES =
  window.I18N_AVAILABLE_LANGUAGES || ["en"];

const DEFAULT_LANGUAGE =
  window.I18N_DEFAULT_LANGUAGE || "en";

function normalizeLanguage(language) {
  return String(language || "")
    .toLowerCase()
    .split("-")[0];
}

function detectLanguage() {
  const url = new URL(window.location.href);

  /*
    1. URL query parameter has highest priority:
       ?lang=de
       ?lang=en
  */
  const urlLanguage = normalizeLanguage(url.searchParams.get("lang"));

  if (AVAILABLE_LANGUAGES.includes(urlLanguage)) {
    localStorage.setItem("solar-monitor-language", urlLanguage);
    return urlLanguage;
  }

  /*
    2. URL hash has second priority:
       #de
       #en
  */
  const hashLanguage = normalizeLanguage(window.location.hash.replace("#", ""));

  if (AVAILABLE_LANGUAGES.includes(hashLanguage)) {
    localStorage.setItem("solar-monitor-language", hashLanguage);
    return hashLanguage;
  }

  /*
    3. Saved user preference.
  */
  const savedLanguage = normalizeLanguage(
    localStorage.getItem("solar-monitor-language")
  );

  if (AVAILABLE_LANGUAGES.includes(savedLanguage)) {
    return savedLanguage;
  }

  /*
    4. Browser / device language.
  */
  const browserLanguages = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language];

  for (const language of browserLanguages) {
    const normalized = normalizeLanguage(language);

    if (AVAILABLE_LANGUAGES.includes(normalized)) {
      return normalized;
    }
  }

  /*
    5. Fallback.
  */
  return DEFAULT_LANGUAGE;
}

let currentLanguage = detectLanguage();

function t(key) {
  return (
    window.I18N?.[currentLanguage]?.[key] ||
    window.I18N?.[DEFAULT_LANGUAGE]?.[key] ||
    key
  );
}

function applyTranslations() {
  document.documentElement.lang = currentLanguage;

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    element.textContent = t(key);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.dataset.i18nPlaceholder;
    element.setAttribute("placeholder", t(key));
  });

  document.title = t("documentTitle") || t("appTitle");
  document.querySelectorAll("[data-language-switch]").forEach((button) => {
  button.classList.toggle(
    "is-active",
    normalizeLanguage(button.dataset.languageSwitch) === currentLanguage
  );
});
}

const MONTHLY_JSONL_ROOT =
  DASHBOARD_CONFIG.monthlyJsonlRoot ||
  DASHBOARD_CONFIG.jsonlRoot ||
  "./exports/timeseries";

/*
  Optional fallback for old single-file exports.
  Used only if no monthly files can be loaded.
*/
const LEGACY_JSONL_PATH =
  DASHBOARD_CONFIG.jsonlPath || "./exports/pv_monitor_timeseries.jsonl";

/*
  Optional:
  If you do not provide a manifest, the dashboard generates month paths
  from DASHBOARD_CONFIG.startMonth or DASHBOARD_CONFIG.startYear up to now.
*/
const MONTHLY_START_MONTH =
  DASHBOARD_CONFIG.startMonth || null; // Example: "2025-11"

const MONTHLY_START_YEAR =
  DASHBOARD_CONFIG.startYear || new Date().getFullYear();

/*
  Optional manifest.
  If present, it should be JSON like:
  {
    "months": ["2025-12", "2026-01", "2026-02"]
  }

  Or simply:
  ["2025-12", "2026-01", "2026-02"]
*/
const MONTHLY_MANIFEST_PATH =
  DASHBOARD_CONFIG.monthlyManifestPath ||
  `${String(MONTHLY_JSONL_ROOT).replace(/\/+$/, "")}/manifest.json`;

const WATCH_INTERVAL_MS = 2500;
const FLOW_MIN_WATTS = 1;

const state = {
  records: [],
  snapshots: [],
  finalState: {},
  numericKeys: [],
  selectedKeys: [],
  labels: new Map(),
  chart: null,
  lastRemoteSignature: null,
  lastContentHash: null,
  isLoadingRemote: false,

  chartRange: "today",
  chartGroup: "overview",
  chartDetailed: true,
  chartFullRangeAxis: true,

  hiddenSeries: new Set(),
  monthlyCache: new Map(),
  monthlyMissing: new Set(),
  monthlyKnownMonths: null,
};

const SYSTEM_OUTPUT_CAP_W = 800;

function formatOutputCap(valueText) {
  const value = toNumber(String(valueText).replace(" W", ""));

  if (value === null) {
    return t("systemOutputSub");
  }

  const percent = Math.min(999, (value / SYSTEM_OUTPUT_CAP_W) * 100);

  return `${formatValue(String(value), "W")} / ${SYSTEM_OUTPUT_CAP_W} W · ${percent.toFixed(0)} %`;
}

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $("fileInput"),
  manualLoadLabel: $("manualLoadLabel"),

  subtitle: $("subtitle"),
  statusText: $("statusText"),
  timeRange: $("timeRange"),

  pvPower: $("pvPower"),
  pvSub: $("pvSub"),
  systemOutputPower: $("systemOutputPower"),
systemOutputSub: $("systemOutputSub"),
  homeLoad: $("homeLoad"),
  homeSub: $("homeSub"),
  batterySoc: $("batterySoc"),
  batteryPower: $("batteryPower"),
  gridPower: $("gridPower"),
  gridSub: $("gridSub"),

  lastUpdate: $("lastUpdate"),
  flowPv: $("flowPv"),
  flowHome: $("flowHome"),
  flowBattery: $("flowBattery"),
  flowGrid: $("flowGrid"),

  energySolarToday: $("energySolarToday"),
  energyHomeToday: $("energyHomeToday"),
  energyChargeToday: $("energyChargeToday"),
  energyDischargeToday: $("energyDischargeToday"),
  energyGridToday: $("energyGridToday"),
  energyExportToday: $("energyExportToday"),

  mainChart: $("mainChart"),
  detailToggle: $("detailToggle"),
  fullRangeToggle: $("fullRangeToggle"),
  chartInsights: $("chartInsights"),

  metricSearch: $("metricSearch"),
  metricList: $("metricList"),
  totalGenerated: $("totalGenerated"),
  co2Saved: $("co2Saved"),
  moneySaved: $("moneySaved"),
};

const COLORS = [
  "#5ee7ff",
  "#4dffb4",
  "#ffd166",
  "#ff5d7a",
  "#b48cff",
  "#5d8cff",
  "#ff9f43",
  "#2dd4bf",
];

const CHART_GROUPS = {
  overview: {
    titleKey: "overview",
    summary: [
      {
        labelKey: "pvPower",
        suffixes: [
          "solarbank_info.total_photovoltaic_power",
          "solarbank_info.total_pv_input_power",
          "input_power",
        ],
        unit: "W",
        axis: "power",
        color: "#ffd166",
      },
      {
        labelKey: "homeLoad",
        suffixes: [
          "home_load_power",
          "other_loads_power",
          "grid_to_home_power",
        ],
        unit: "W",
        axis: "power",
        color: "#5ee7ff",
      },
      {
        labelKey: "batterySoc",
        suffixes: [
          "battery_soc",
          "battery_soc_total",
        ],
        unit: "%",
        axis: "percent",
        color: "#4dffb4",
      },
      {
        labelKey: "gridImport",
        suffixes: [
          "grid_to_home_power",
          "mqtt.grid_to_home_power",
          "grid_power_signed",
        ],
        unit: "W",
        axis: "power",
        color: "#b48cff",
      },
    ],
    detail: [
      {
        labelKey: "batteryCharge",
        suffixes: [
          "solarbank_info.total_charging_power",
          "bat_charge_power",
          "charging_power",
        ],
        unit: "W",
        axis: "power",
        color: "#14f1d0",
      },
      {
        labelKey: "batteryDischarge",
        suffixes: [
          "solarbank_info.battery_discharge_power",
          "battery_discharge_power",
          "bat_discharge_power",
        ],
        unit: "W",
        axis: "power",
        color: "#ff9f43",
      },
    ],
  },

  solar: {
    titleKey: "solar",
    summary: [
      {
        labelKey: "pvTotal",
        suffixes: [
          "solarbank_info.total_photovoltaic_power",
          "solarbank_info.total_pv_input_power",
          "photovoltaic_power",
          "input_power",
        ],
        unit: "W",
        axis: "power",
        color: "#78ff66",
      },
    ],
    detail: [
      {
        labelKey: "pv1",
        suffixes: ["solar_power_1", "mqtt.pv_1_power"],
        unit: "W",
        axis: "power",
        color: "#f73f3f",
      },
      {
        labelKey: "pv2",
        suffixes: ["solar_power_2", "mqtt.pv_2_power"],
        unit: "W",
        axis: "power",
        color: "#36fafa",
      },
      {
        labelKey: "pv3",
        suffixes: ["solar_power_3", "mqtt.pv_3_power"],
        unit: "W",
        axis: "power",
        color: "#ea03ff",
      },
      {
        labelKey: "pv4",
        suffixes: ["solar_power_4", "mqtt.pv_4_power"],
        unit: "W",
        axis: "power",
        color: "#fb8500",
      },
      {
        labelKey: "pvExport",
        suffixes: [
          "photovoltaic_to_grid_power",
          "mqtt.pv_to_grid_power",
        ],
        unit: "W",
        axis: "power",
        color: "#003af7",
      },
    ],
  },

  battery: {
    titleKey: "battery",
    summary: [
      {
        labelKey: "batterySoc",
        suffixes: [
          "battery_soc",
          "battery_soc_total",
        ],
        unit: "%",
        axis: "percent",
        color: "#4dffb4",
      },
      {
        labelKey: "chargePower",
        suffixes: [
          "solarbank_info.total_charging_power",
          "bat_charge_power",
          "charging_power",
          "mqtt.bat_charge_power",
        ],
        unit: "W",
        axis: "power",
        color: "#14f1d0",
      },
      {
        labelKey: "dischargePower",
        suffixes: [
          "solarbank_info.battery_discharge_power",
          "battery_discharge_power",
          "bat_discharge_power",
          "mqtt.bat_discharge_power",
        ],
        unit: "W",
        axis: "power",
        color: "#ff9f43",
      },
    ],
    detail: [
      {
        labelKey: "batteryEnergy",
        suffixes: ["battery_energy"],
        unit: "Wh",
        axis: "energy",
        color: "#5d8cff",
      },
      {
        labelKey: "gridToBattery",
        suffixes: ["grid_to_battery_power"],
        unit: "W",
        axis: "power",
        color: "#b48cff",
      },
    ],
  },

  house: {
    titleKey: "house",
    summary: [
        {
        labelKey: "homeLoad",
        suffixes: [
            "home_load_power",
            "other_loads_power",
        ],
        unit: "W",
        axis: "power",
        color: "#5ee7ff",
        houseTotal: true,
        },
        {
        labelKey: "gridToHome",
        suffixes: [
            "grid_to_home_power",
            "mqtt.grid_to_home_power",
        ],
        unit: "W",
        axis: "power",
        color: "#b48cff",
        houseContribution: true,
        },
        {
        labelKey: "solarToHome",
        suffixes: [
            "solarbank_info.to_home_load",
            "to_home_load",
            "output_power",
        ],
        unit: "W",
        axis: "power",
        color: "#ffd166",
        houseContribution: true,
        },
        {
        labelKey: "batteryToHome",
        suffixes: [
            "solarbank_info.battery_discharge_power",
            "battery_discharge_power",
            "bat_discharge_power",
        ],
        unit: "W",
        axis: "power",
        color: "#4dffb4",
        houseContribution: true,
        },
    ],
    detail: [
        {
        labelKey: "smartPlugs",
        suffixes: [
            "smart_plug_info.total_power",
            "current_power",
        ],
        unit: "W",
        axis: "power",
        color: "#ff5d7a",
        },
    ],
    },

  grid: {
    titleKey: "grid",
    summary: [
      {
        labelKey: "gridImport",
        suffixes: [
          "grid_to_home_power",
          "mqtt.grid_to_home_power",
          "grid_power_signed",
        ],
        unit: "W",
        axis: "power",
        color: "#b48cff",
      },
      {
        labelKey: "gridExport",
        suffixes: [
          "photovoltaic_to_grid_power",
          "mqtt.pv_to_grid_power",
        ],
        unit: "W",
        axis: "power",
        color: "#4dffb4",
      },
    ],
    detail: [
      {
        labelKey: "gridL1",
        suffixes: ["mqtt.grid_power_signed_l1"],
        unit: "W",
        axis: "power",
        color: "#a78bfa",
      },
      {
        labelKey: "gridL2",
        suffixes: ["mqtt.grid_power_signed_l2"],
        unit: "W",
        axis: "power",
        color: "#c084fc",
      },
      {
        labelKey: "gridL3",
        suffixes: ["mqtt.grid_power_signed_l3"],
        unit: "W",
        axis: "power",
        color: "#e879f9",
      },
    ],
  },

  energy: {
    titleKey: "energy",
    summary: [
      {
        labelKey: "solarProduction",
        suffixes: ["energy_details.today.solar_production"],
        unit: "kWh",
        axis: "energy",
        color: "#ffd166",
        cumulative: true,
      },
      {
        labelKey: "homeUsage",
        suffixes: ["energy_details.today.home_usage"],
        unit: "kWh",
        axis: "energy",
        color: "#5ee7ff",
        cumulative: true,
      },
      {
        labelKey: "batteryCharge",
        suffixes: ["energy_details.today.battery_charge"],
        unit: "kWh",
        axis: "energy",
        color: "#4dffb4",
        cumulative: true,
      },
      {
        labelKey: "batteryDischarge",
        suffixes: ["energy_details.today.battery_discharge"],
        unit: "kWh",
        axis: "energy",
        color: "#ff9f43",
        cumulative: true,
      },
    ],
    detail: [
      {
        labelKey: "gridToHome",
        suffixes: [
          "energy_details.today.grid_to_home",
          "energy_details.today.grid_import",
        ],
        unit: "kWh",
        axis: "energy",
        color: "#b48cff",
        cumulative: true,
      },
      {
        labelKey: "solarExport",
        suffixes: [
          "energy_details.today.solar_to_grid",
          "energy_details.today.grid_export",
        ],
        unit: "kWh",
        axis: "energy",
        color: "#14f1d0",
        cumulative: true,
      },
      {
        labelKey: "pv1Production",
        suffixes: ["energy_details.today.solar_production_pv1"],
        unit: "kWh",
        axis: "energy",
        color: "#ffe08a",
        cumulative: true,
      },
      {
        labelKey: "pv2Production",
        suffixes: ["energy_details.today.solar_production_pv2"],
        unit: "kWh",
        axis: "energy",
        color: "#ffc857",
        cumulative: true,
      },
      {
        labelKey: "pv3Production",
        suffixes: ["energy_details.today.solar_production_pv3"],
        unit: "kWh",
        axis: "energy",
        color: "#8aff94",
        cumulative: true,
      },
      {
        labelKey: "pv4Production",
        suffixes: ["energy_details.today.solar_production_pv4"],
        unit: "kWh",
        axis: "energy",
        color: "#5dff57",
        cumulative: true,
      },
    ],
  },
};

function getSeriesLabel(definition) {
  if (definition.labelKey) {
    return t(definition.labelKey);
  }

  return definition.label || definition.key || "";
}

function isCompactViewport() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function formatAxisTick(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return value;
  }

  const abs = Math.abs(number);

  if (abs >= 1000000) {
    return `${(number / 1000000).toFixed(1)}M`;
  }

  if (abs >= 1000) {
    return `${(number / 1000).toFixed(1)}k`;
  }

  if (abs >= 100) {
    return number.toFixed(0);
  }

  if (abs >= 10) {
    return number.toFixed(0);
  }

  return number.toFixed(1);
}

function findSiteStatisticByType(type, fallbackIndex = null) {
  /*
    Anker statistics usually look like:
    statistics.0.type = "1" → generated energy
    statistics.1.type = "2" → CO₂ saved
    statistics.2.type = "3" → money saved
  */

  const entries = Object.entries(state.finalState);

  for (const [key, value] of entries) {
    const match = key.match(/^sites\.[^.]+\.statistics\.(\d+)\.type$/);

    if (!match) {
      continue;
    }

    if (String(value) !== String(type)) {
      continue;
    }

    const prefix = key.replace(/\.type$/, "");
    const total = state.finalState[`${prefix}.total`];
    const unit = state.finalState[`${prefix}.unit`];

    if (total !== undefined) {
      return {
        total,
        unit: unit || "",
      };
    }
  }

  if (fallbackIndex !== null) {
    const totalKey = Object.keys(state.finalState).find((key) =>
      key.endsWith(`statistics.${fallbackIndex}.total`)
    );

    if (totalKey) {
      const prefix = totalKey.replace(/\.total$/, "");

      return {
        total: state.finalState[`${prefix}.total`],
        unit: state.finalState[`${prefix}.unit`] || "",
      };
    }
  }

  return null;
}

function formatStatistic(stat) {
  if (!stat) {
    return "—";
  }

  const number = toNumber(stat.total);
  const unit = stat.unit || "";

  if (number === null) {
    return `${stat.total}${unit ? ` ${unit}` : ""}`;
  }

  let formatted;

  if (Math.abs(number) >= 1000) {
    formatted = number.toFixed(0);
  } else if (Math.abs(number) >= 100) {
    formatted = number.toFixed(1);
  } else if (Math.abs(number) >= 10) {
    formatted = number.toFixed(2);
  } else {
    formatted = number.toFixed(2);
  }

  return `${formatted}${unit ? ` ${unit}` : ""}`;
}

function updateScrollableFades() {
  document.querySelectorAll(".chart-control-block").forEach((block) => {
    const scroller = block.querySelector(".chart-tabs");

    if (!scroller) {
      return;
    }

    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
    const scrollLeft = scroller.scrollLeft;

    const hasScrollableContent = maxScrollLeft > 2;
    const hasLeft = hasScrollableContent && scrollLeft > 2;
    const hasRight = hasScrollableContent && scrollLeft < maxScrollLeft - 2;

    block.classList.toggle("has-scroll-left", hasLeft);
    block.classList.toggle("has-scroll-right", hasRight);
  });
}

function formatXAxisTick(value, visibleSpanMs) {
  const date = new Date(value);

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const monthApprox = 30 * day;
  const yearApprox = 365 * day;

  /*
    Important:
    This is based on actual visible span, not only selected range.
    So "All" with only 2 hours of data shows time.
  */

  if (!visibleSpanMs || visibleSpanMs <= 36 * hour) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  if (visibleSpanMs <= 3 * day) {
    return date.toLocaleString([], {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  if (visibleSpanMs <= 14 * day) {
    return date.toLocaleDateString([], {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    });
  }

  if (visibleSpanMs <= 2 * monthApprox) {
    return date.toLocaleDateString([], {
      day: "2-digit",
      month: "2-digit",
    });
  }

  if (visibleSpanMs <= 2 * yearApprox) {
    return date.toLocaleDateString([], {
      month: "2-digit",
      year: "2-digit",
    });
  }

  return date.toLocaleDateString([], {
    year: "numeric",
  });
}

function makeSeriesId(definition) {
  /*
    Stable ID for remembering whether a graph line was hidden.
    Includes chart group so hiding "Battery SoC" in Overview does not
    necessarily hide it in Battery view.
  */
  return `${state.chartGroup}::${definition.labelKey || definition.label || "series"}::${definition.key}`;
}

function syncHiddenSeriesFromChart() {
  if (!state.chart) return;

  state.chart.data.datasets.forEach((dataset, index) => {
    if (!dataset.seriesId) return;

    const visible = state.chart.isDatasetVisible(index);

    if (visible) {
      state.hiddenSeries.delete(dataset.seriesId);
    } else {
      state.hiddenSeries.add(dataset.seriesId);
    }
  });
}

function exactPathMatches(key, suffix) {
  return key === suffix || key.endsWith(`.${suffix}`);
}

function findNumbersBySuffix(suffix) {
  const ignoredPathParts = [
    ".energy_details.",
    ".statistics.",
    ".tariff.",
  ];

  return Object.entries(state.finalState)
    .filter(([key]) => {
      return !ignoredPathParts.some((part) => key.includes(part));
    })
    .filter(([key]) => exactPathMatches(key, suffix))
    .map(([key, value]) => {
      const number = toNumber(value);

      if (number === null) {
        return null;
      }

      return {
        key,
        value: number,
      };
    })
    .filter(Boolean);
}

/*
  Important:
  This uses priority order.
  If the first available source says 0 W, we keep 0 W.
  We do NOT skip to another source just because it has a non-zero stale value.
*/
function firstNumberBySuffixes(suffixes) {
  for (const suffix of suffixes) {
    const matches = findNumbersBySuffix(suffix);

    if (!matches.length) {
      continue;
    }

    const siteMatch = matches.find((item) => item.key.startsWith("sites."));
    if (siteMatch) {
      return siteMatch;
    }

    return matches[0];
  }

  return null;
}

function isPositiveWatts(value) {
  return (
    value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value >= FLOW_MIN_WATTS
  );
}

function formatWatts(value) {
  if (!isPositiveWatts(value)) {
    return "—";
  }

  if (value >= 100) {
    return `${value.toFixed(0)} W`;
  }

  if (value >= 10) {
    return `${value.toFixed(1)} W`;
  }

  return `${value.toFixed(1)} W`;
}

function getFlowValues() {
  const pvPower = firstNumberBySuffixes([
    "solarbank_info.total_photovoltaic_power",
    "solarbank_info.total_pv_input_power",
    "mqtt.pv_power_total",
    "mqtt.photovoltaic_power",
    "photovoltaic_power",
    "input_power",
  ]);

  const pvToHome = firstNumberBySuffixes([
    "solarbank_info.to_home_load",
    "solarbank_info.total_home_load_power",
    "to_home_load",
    "mqtt.output_power",
    "mqtt.ac_output_power",
    "output_power",
  ]);

  const batteryCharge = firstNumberBySuffixes([
    "solarbank_info.total_charging_power",
    "mqtt.bat_charge_power",
    "bat_charge_power",
    "mqtt.charging_power",
    "charging_power",
  ]);

  const batteryDischarge = firstNumberBySuffixes([
    "solarbank_info.battery_discharge_power",
    "battery_discharge_power",
    "mqtt.bat_discharge_power",
    "bat_discharge_power",
  ]);

  const gridToHome = firstNumberBySuffixes([
    "grid_to_home_power",
    "mqtt.grid_to_home_power",
    "grid_power_signed",
    "mqtt.grid_power_signed",
  ]);

  const pv = pvPower ? pvPower.value : null;
  const toHome = pvToHome ? pvToHome.value : null;
  const charge = batteryCharge ? batteryCharge.value : null;
  const discharge = batteryDischarge ? batteryDischarge.value : null;
  const grid = gridToHome ? gridToHome.value : null;

  const pvHomeValue =
    isPositiveWatts(pv) && isPositiveWatts(toHome)
      ? Math.min(pv, toHome)
      : null;

  const pvBatteryValue =
    isPositiveWatts(pv) && isPositiveWatts(charge)
      ? Math.min(pv, charge)
      : null;

  return {
    pvHome: {
      value: pvHomeValue,
      active: isPositiveWatts(pvHomeValue),
      label: formatWatts(pvHomeValue),
      source: pvToHome ? pvToHome.key : null,
      pvSource: pvPower ? pvPower.key : null,
    },

    pvBattery: {
      value: pvBatteryValue,
      active: isPositiveWatts(pvBatteryValue),
      label: formatWatts(pvBatteryValue),
      source: batteryCharge ? batteryCharge.key : null,
      pvSource: pvPower ? pvPower.key : null,
    },

    batteryHome: {
      value: discharge,
      active: isPositiveWatts(discharge),
      label: formatWatts(discharge),
      source: batteryDischarge ? batteryDischarge.key : null,
    },

    gridHome: {
      value: grid,
      active: isPositiveWatts(grid),
      label: formatWatts(grid),
      source: gridToHome ? gridToHome.key : null,
    },
  };
}

function setFlowActive(pathId, labelId, active) {
  const path = document.getElementById(pathId);
  const label = document.getElementById(labelId);

  if (path) {
    path.classList.toggle("is-active", active);

    /*
      Remove leftovers from earlier versions.
      display:none on SVG paths can make them appear "gone"
      even when classes are correct.
    */
    path.style.removeProperty("display");
    path.style.removeProperty("opacity");
    path.style.removeProperty("visibility");
    path.style.removeProperty("animation-play-state");

    if (active) {
      path.setAttribute("visibility", "visible");
    } else {
      path.setAttribute("visibility", "hidden");
    }
  }

  if (label) {
    label.classList.toggle("is-active", active);

    label.style.removeProperty("display");
    label.style.removeProperty("opacity");
    label.style.removeProperty("visibility");

    if (active) {
      label.setAttribute("visibility", "visible");
    } else {
      label.setAttribute("visibility", "hidden");
    }
  }
}

function centerOfNode(node, container) {
  const nodeRect = node.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  return {
    x: nodeRect.left - containerRect.left + nodeRect.width / 2,
    y: nodeRect.top - containerRect.top + nodeRect.height / 2,
    r: Math.min(nodeRect.width, nodeRect.height) / 2,
  };
}

function pointOnCircle(from, to, padding = 12) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;

  return {
    x: from.x + (dx / length) * (from.r + padding),
    y: from.y + (dy / length) * (from.r + padding),
  };
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function offsetPoint(point, offsetX = 0, offsetY = 0) {
  return {
    x: point.x + offsetX,
    y: point.y + offsetY,
  };
}

function connectStraight(path, from, to) {
  const start = pointOnCircle(from, to, 10);
  const end = pointOnCircle(to, from, 10);

  path.setAttribute(
    "d",
    `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`
  );

  return {
    start,
    end,
    label: midpoint(start, end),
  };
}

function connectCurve(path, from, to, curve = 0.35) {
  const start = pointOnCircle(from, to, 10);
  const end = pointOnCircle(to, from, 10);

  const dx = end.x - start.x;
  const dy = end.y - start.y;

  const c1 = {
    x: start.x + dx * curve,
    y: start.y,
  };

  const c2 = {
    x: end.x - dx * curve,
    y: end.y,
  };

  path.setAttribute(
    "d",
    `M ${start.x.toFixed(1)} ${start.y.toFixed(1)}
     C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)},
       ${c2.x.toFixed(1)} ${c2.y.toFixed(1)},
       ${end.x.toFixed(1)} ${end.y.toFixed(1)}`
  );

  return {
    start,
    end,
    c1,
    c2,
    label: cubicBezierPoint(start, c1, c2, end, 0.5),
  };
}

function cubicBezierPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;

  return {
    x:
      mt * mt * mt * p0.x +
      3 * mt * mt * t * p1.x +
      3 * mt * t * t * p2.x +
      t * t * t * p3.x,
    y:
      mt * mt * mt * p0.y +
      3 * mt * mt * t * p1.y +
      3 * mt * t * t * p2.y +
      t * t * t * p3.y,
  };
}

function setFlowLabel(id, text, point) {
  const group = document.getElementById(id);

  if (!group) {
    return;
  }

  const labelText = group.querySelector("text");

  if (!labelText || !text || text === "—") {
    group.classList.remove("is-active");
    group.setAttribute("visibility", "hidden");
    return;
  }

  group.classList.add("is-active");
  group.setAttribute("visibility", "visible");

  group.setAttribute(
    "transform",
    `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`
  );

  labelText.textContent = text;
}

function updateFlowLines() {
  const flow = document.querySelector(".flow");
  const svg = document.getElementById("flowSvg");

  if (!flow || !svg) return;

  const pvNode = document.querySelector(".node-pv");
  const homeNode = document.querySelector(".node-home");
  const batteryNode = document.querySelector(".node-battery");
  const gridNode = document.querySelector(".node-grid");

  if (!pvNode || !homeNode || !batteryNode || !gridNode) return;

  const rect = flow.getBoundingClientRect();

  svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);

  const pv = centerOfNode(pvNode, flow);
  const home = centerOfNode(homeNode, flow);
  const battery = centerOfNode(batteryNode, flow);
  const grid = centerOfNode(gridNode, flow);

  const pvHome = connectCurve(
    document.getElementById("pathPvHome"),
    pv,
    home,
    0.5
  );

  const pvBattery = connectCurve(
    document.getElementById("pathPvBattery"),
    pv,
    battery,
    0.38
  );

  const batteryHome = connectStraight(
    document.getElementById("pathBatteryHome"),
    battery,
    home
  );

  const gridHome = connectStraight(
    document.getElementById("pathGridHome"),
    grid,
    home
  );
  const flows = getFlowValues();

  setFlowActive("pathPvHome", "labelPvHome", flows.pvHome.active);
  setFlowActive("pathPvBattery", "labelPvBattery", flows.pvBattery.active);
  setFlowActive("pathBatteryHome", "labelBatteryHome", flows.batteryHome.active);
  setFlowActive("pathGridHome", "labelGridHome", flows.gridHome.active);

  const compactFlow = window.matchMedia("(max-width: 760px)").matches;

if (flows.pvHome.active) {
  setFlowLabel(
    "labelPvHome",
    flows.pvHome.label,
    compactFlow
      ? offsetPoint(pvHome.label, 0, -16)
      : offsetPoint(pvHome.label, 34, 0)
  );
}

if (flows.pvBattery.active) {
  setFlowLabel(
    "labelPvBattery",
    flows.pvBattery.label,
    compactFlow
      ? offsetPoint(pvBattery.label, -18, 0)
      : offsetPoint(pvBattery.label, -28, -10)
  );
}

if (flows.batteryHome.active) {
  setFlowLabel(
    "labelBatteryHome",
    flows.batteryHome.label,
    compactFlow
      ? offsetPoint(batteryHome.label, 0, -14)
      : offsetPoint(batteryHome.label, 0, -22)
  );
}

if (flows.gridHome.active) {
  setFlowLabel(
    "labelGridHome",
    flows.gridHome.label,
    compactFlow
      ? offsetPoint(gridHome.label, 18, 0)
      : offsetPoint(gridHome.label, 0, -22)
  );
}
}

window.addEventListener("resize", updateFlowLines);
window.addEventListener("load", updateFlowLines);

// Recalculate after layout settles.
requestAnimationFrame(updateFlowLines);
setTimeout(updateFlowLines, 250);
setTimeout(updateFlowLines, 1000);


function setStatus(text, mode = "neutral") {
  els.statusText.textContent = text;

  const dot = document.querySelector(".status-dot");
  dot.classList.remove("ok", "error");

  if (mode === "ok") dot.classList.add("ok");
  if (mode === "error") dot.classList.add("error");
}

function showManualLoadButton() {
  els.manualLoadLabel?.classList.remove("hidden");
}

function hideManualLoadButton() {
  els.manualLoadLabel?.classList.add("hidden");
}

function hashText(text) {
  // Fast small non-cryptographic hash, good enough to detect file changes.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
       Math.imul(h2 ^ (h2 >>> 13), 3266489909);

  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
       Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function monthKeyFromDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function currentMonthKey() {
  return monthKeyFromDate(new Date());
}

function monthlyRootPath() {
  return String(MONTHLY_JSONL_ROOT).replace(/\/+$/, "");
}

function monthlyJsonlPath(monthKey) {
  const [year] = monthKey.split("-");
  return `${monthlyRootPath()}/${year}/${monthKey}.jsonl`;
}

function monthlyJsonlUrl(monthKey, cacheBust = false) {
  const url = new URL(monthlyJsonlPath(monthKey), window.location.href);

  if (cacheBust) {
    url.searchParams.set("_", String(Date.now()));
  }

  return url;
}

function legacyJsonlUrl(cacheBust = false) {
  const url = new URL(LEGACY_JSONL_PATH, window.location.href);

  if (cacheBust) {
    url.searchParams.set("_", String(Date.now()));
  }

  return url;
}

function parseMonthKey(monthKey) {
  const match = String(monthKey).match(/^(\d{4})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return null;
  }

  return new Date(year, month - 1, 1, 0, 0, 0, 0);
}

function monthKeysBetween(startDate, endDate) {
  const result = [];

  const cursor = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    1,
    0,
    0,
    0,
    0
  );

  const end = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    1,
    0,
    0,
    0,
    0
  );

  while (cursor <= end) {
    result.push(monthKeyFromDate(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return result;
}

function configuredStartDate() {
  if (MONTHLY_START_MONTH) {
    const parsed = parseMonthKey(MONTHLY_START_MONTH);

    if (parsed) {
      return parsed;
    }
  }

  const year = Number(MONTHLY_START_YEAR);

  if (Number.isInteger(year) && year >= 2000 && year <= 2200) {
    return new Date(year, 0, 1, 0, 0, 0, 0);
  }

  const now = new Date();
  return new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
}

async function fetchMonthlyManifest() {
  if (state.monthlyKnownMonths !== null) {
    return state.monthlyKnownMonths;
  }

  const url = new URL(MONTHLY_MANIFEST_PATH, window.location.href);

  try {
    const response = await fetch(`${url.toString()}?_=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      state.monthlyKnownMonths = [];
      return state.monthlyKnownMonths;
    }

    const json = await response.json();
    const months = Array.isArray(json) ? json : json.months;

    if (!Array.isArray(months)) {
      state.monthlyKnownMonths = [];
      return state.monthlyKnownMonths;
    }

    state.monthlyKnownMonths = [...new Set(
      months
        .map((item) => String(item).trim())
        .filter((item) => /^\d{4}-\d{2}$/.test(item))
    )].sort();

    return state.monthlyKnownMonths;
  } catch {
    state.monthlyKnownMonths = [];
    return state.monthlyKnownMonths;
  }
}

async function monthKeysForCurrentRange() {
  const now = new Date();
  const bounds = getNominalRangeBounds(state.chartRange);

  if (state.chartRange === "all") {
    const manifestMonths = await fetchMonthlyManifest();

    if (manifestMonths.length) {
      return manifestMonths;
    }

    return monthKeysBetween(configuredStartDate(), now);
  }

  if (state.chartRange === "currentYear") {
    return monthKeysBetween(
      new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0),
      now
    );
  }

  if (state.chartRange === "last365d") {
    return monthKeysBetween(
      new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
      now
    );
  }

  if (bounds.min !== null) {
    return monthKeysBetween(new Date(bounds.min), now);
  }

  return [currentMonthKey()];
}

async function fetchMonthlyJsonl(monthKey, { force = false, required = false } = {}) {
  const isCurrentMonth = monthKey === currentMonthKey();
  const cached = state.monthlyCache.get(monthKey);

  /*
    Old months should normally never change.
    Current month is fetched every watch cycle.
  */
  if (!force && !isCurrentMonth && cached) {
    return cached.text;
  }

  if (!force && !isCurrentMonth && state.monthlyMissing.has(monthKey)) {
    return null;
  }

  const url = monthlyJsonlUrl(monthKey, isCurrentMonth || force);

  try {
    const response = await fetch(url.toString(), {
      cache: "no-store",
    });

    if (response.status === 404) {
      state.monthlyMissing.add(monthKey);

      if (required) {
        throw new Error(`404 ${t("whileLoading")} ${url.pathname}`);
      }

      return null;
    }

    if (!response.ok) {
      if (required) {
        throw new Error(
          `${response.status} ${response.statusText} ${t("whileLoading")} ${url.pathname}`
        );
      }

      state.monthlyMissing.add(monthKey);
      return null;
    }

    const text = await response.text();

    state.monthlyCache.set(monthKey, {
      text,
      loadedAt: Date.now(),
    });

    state.monthlyMissing.delete(monthKey);

    return text;
  } catch (error) {
    if (required) {
      throw error;
    }

    state.monthlyMissing.add(monthKey);
    return null;
  }
}

async function fetchLegacyJsonl() {
  const url = legacyJsonlUrl(true);

  const response = await fetch(url.toString(), {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} ${t("whileLoading")} ${url.pathname}`);
  }

  return response.text();
}

function parseJsonl(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const records = [];

  for (const line of lines) {
    const record = JSON.parse(line);

    if (!record.timestamp_unix || !record.values) {
      continue;
    }

    records.push(record);
  }

  records.sort((a, b) => Number(a.timestamp_unix) - Number(b.timestamp_unix));

  const flat = {};
  const snapshots = [];
  const numericKeys = new Set();

  for (const record of records) {
    if (record.mode === "full") {
      for (const key of Object.keys(flat)) {
        delete flat[key];
      }
    }

    for (const [key, value] of Object.entries(record.values || {})) {
      flat[key] = value;
    }

    for (const key of record.removed || []) {
      delete flat[key];
    }

    for (const [key, value] of Object.entries(flat)) {
      if (toNumber(value) !== null) {
        numericKeys.add(key);
      }
    }

    snapshots.push({
      time: Number(record.timestamp_unix) * 1000,
      iso: record.timestamp,
      values: { ...flat },
    });
  }

  if (!records.length) {
    throw new Error(t("noValidJsonlRecords"));
  }

  return {
    records,
    snapshots,
    finalState: { ...flat },
    numericKeys: [...numericKeys].sort(),
  };
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  if (/[a-zA-Z]/.test(trimmed)) return null;

  const normalized = trimmed.replace(",", ".");

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function inferUnit(key) {
  const k = key.toLowerCase();

  if (
    k.includes("soc") ||
    k.includes("percentage") ||
    k.endsWith("total_battery_power")
  ) {
    return "%";
  }

  if (
    k.includes("power") ||
    k.includes("load") ||
    k.includes("demand") ||
    k.includes("to_home")
  ) {
    return "W";
  }

  if (k.includes("energy") || k.includes("production") || k.includes("usage")) {
    if (k.includes("battery_energy")) return "Wh";
    return "kWh";
  }

  return "";
}

function formatValue(value, unit = "") {
  const number = toNumber(value);

  if (number === null) return "—";

  let formatted;

  if (unit === "%") {
    formatted = number.toFixed(0);
  } else if (Math.abs(number) >= 100) {
    formatted = number.toFixed(0);
  } else if (Math.abs(number) >= 10) {
    formatted = number.toFixed(1);
  } else {
    formatted = number.toFixed(2);
  }

  return `${formatted}${unit ? ` ${unit}` : ""}`;
}

function findLatest(fragments) {
  const keys = Object.keys(state.finalState);

  for (const fragment of fragments) {
    const found = keys.find((key) => key.endsWith(fragment));
    if (found) {
      return {
        key: found,
        value: state.finalState[found],
        unit: inferUnit(found),
      };
    }
  }

  return null;
}

function getValue(fragments) {
  return findLatest(fragments)?.value ?? null;
}

function getFormatted(fragments, forcedUnit = null) {
  const found = findLatest(fragments);
  if (!found) return "—";

  return formatValue(found.value, forcedUnit ?? found.unit);
}

function updateDashboard() {
  const pv = getFormatted([
    "solarbank_info.total_photovoltaic_power",
    "total_photovoltaic_power",
    "input_power",
  ], "W");
  const systemOutputRaw = findLatest([
    "solarbank_info.to_home_load",
    "solarbank_info.total_output_power",
    "to_home_load",
    "output_power",
    "mqtt.output_power",
    "mqtt.ac_output_power",
    ]);
  const systemOutputNumber = systemOutputRaw
    ? toNumber(systemOutputRaw.value)
    : null;
  const home = getFormatted([
    "home_load_power",
    "other_loads_power",
    "grid_to_home_power",
  ], "W");

  const batterySoc = getFormatted([
    "battery_soc",
    "solarbank_info.total_battery_power",
    "battery_soc_total",
  ], "%");

  const batteryCharge = getFormatted([
    "bat_charge_power",
    "charging_power",
    "solarbank_info.total_charging_power",
  ], "W");

  const batteryDischarge = getFormatted([
    "bat_discharge_power",
    "battery_discharge_power",
  ], "W");

  const grid = getFormatted([
    "grid_to_home_power",
    "grid_power_signed",
  ], "W");

  const generated = findSiteStatisticByType("1", 0);
  const co2 = findSiteStatisticByType("2", 1);
  const savings = findSiteStatisticByType("3", 2);

  els.pvPower.textContent = pv;
  els.systemOutputSub.textContent = systemOutputNumber === null
  ? t("systemOutputSub")
  : `${systemOutputNumber.toFixed(0)} W ${t("ofLimit")} ${SYSTEM_OUTPUT_CAP_W} W · ${((systemOutputNumber / SYSTEM_OUTPUT_CAP_W) * 100).toFixed(0)} %`;
  els.homeLoad.textContent = home;
  els.batterySoc.textContent = batterySoc;
  els.batteryPower.textContent =
  `${t("charge")} ${batteryCharge} · ${t("discharge")} ${batteryDischarge}`;
  els.gridPower.textContent = grid;

  els.flowPv.textContent = pv;
  els.flowHome.textContent = home;
  els.flowBattery.textContent = batterySoc;
  els.flowGrid.textContent = grid;

  els.energySolarToday.textContent = getFormatted([
    "energy_details.today.solar_production",
  ], "kWh");

  els.energyHomeToday.textContent = getFormatted([
    "energy_details.today.home_usage",
  ], "kWh");

  els.energyChargeToday.textContent = getFormatted([
    "energy_details.today.battery_charge",
  ], "kWh");

  els.energyDischargeToday.textContent = getFormatted([
    "energy_details.today.battery_discharge",
  ], "kWh");

  els.energyGridToday.textContent = getFormatted([
    "energy_details.today.grid_to_home",
    "energy_details.today.grid_import",
  ], "kWh");

  els.energyExportToday.textContent = getFormatted([
    "energy_details.today.solar_to_grid",
    "energy_details.today.grid_export",
  ], "kWh");

  const last = state.snapshots.at(-1);
  if (last) {
    els.lastUpdate.textContent = new Date(last.time).toLocaleTimeString();
  }
  if (els.totalGenerated) {
    els.totalGenerated.textContent = formatStatistic(generated);
  }

  if (els.co2Saved) {
    els.co2Saved.textContent = formatStatistic(co2);
  }

  if (els.moneySaved) {
    els.moneySaved.textContent = formatStatistic(savings);
  }
  updateFlowLines();
}

function buildLabels() {
  state.labels = new Map();

  for (const key of state.numericKeys) {
    state.labels.set(key, cleanLabel(key));
  }
}

function cleanLabel(key) {
  return key
    .replace(/^sites\.[^.]+\./, `${t("site")} · `)
    .replace(/^devices\.([^.]+)\./, `${t("device")} · `)
    .replace(/solarbank_info\./g, "")
    .replace(/energy_details\./g, "")
    .replace(/\./g, " · ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function selectChartGroup(groupName) {
  if (state.chartGroup !== groupName) {
    syncHiddenSeriesFromChart();
  }

  if (groupName !== "custom") {
    state.selectedKeys = [];
  }

  state.chartGroup = groupName;

  updateChart();
  renderMetricList();
}

function selectChartRange(rangeName) {
  state.chartRange = rangeName;

  /*
    Immediately update with already loaded data.
    Then load the months required for the selected range.
  */
  updateChart();

  loadDefaultFromExports({
    force: false,
    silent: true,
  });
}

function axisForUnit(unit) {
  if (unit === "%") return "percent";
  if (unit === "kWh" || unit === "Wh") return "energy";
  return "power";
}

function buildDataset(definition, index, snapshots) {
  const color = definition.color || COLORS[index % COLORS.length];
  const seriesId = makeSeriesId(definition);

  const data = snapshots
    .map((snapshot) => {
      const value = snapshot.values[definition.key];
      const number = toNumber(value);

      if (number === null) {
        return null;
      }

      return {
        x: snapshot.time,
        y: number,
      };
    })
    .filter(Boolean);

  return {
    label: `${getSeriesLabel(definition)}${definition.unit ? ` [${definition.unit}]` : ""}`,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2.4,
    pointRadius: data.length > 300 ? 0 : 2,
    pointHoverRadius: 5,
    tension: 0.32,
    yAxisID: definition.axis,
    unit: definition.unit,
    axis: definition.axis,
    cumulative: Boolean(definition.cumulative),
    
    seriesId,
    hidden: state.hiddenSeries.has(seriesId),
    labelKey: definition.labelKey,
    houseTotal: Boolean(definition.houseTotal),
    houseContribution: Boolean(definition.houseContribution),
    houseContributionPercent: null,
    houseContributionKWh: null,
  };
}

function applyHouseContributionPercentages(datasets) {
  if (state.chartGroup !== "house") {
    return;
  }

  const totalDataset = datasets.find((dataset) => dataset.houseTotal);
  const contributionDatasets = datasets.filter((dataset) => dataset.houseContribution);

  if (!contributionDatasets.length) {
    return;
  }

  const contributionEnergy = new Map();

  let contributionSumKWh = 0;

  for (const dataset of contributionDatasets) {
    const kWh = estimateEnergyKWh(dataset.data) || 0;

    contributionEnergy.set(dataset.seriesId, kWh);
    contributionSumKWh += kWh;
  }

  /*
    Prefer Home Load as denominator.
    If unavailable or 0, fall back to the sum of the source contributions.
  */
  const totalHouseKWh = totalDataset
    ? estimateEnergyKWh(totalDataset.data)
    : null;

  const denominatorKWh =
    totalHouseKWh && totalHouseKWh > 0
      ? totalHouseKWh
      : contributionSumKWh;

  if (!denominatorKWh || denominatorKWh <= 0) {
    return;
  }

  for (const dataset of contributionDatasets) {
    const kWh = contributionEnergy.get(dataset.seriesId) || 0;
    const percent = (kWh / denominatorKWh) * 100;

    dataset.houseContributionKWh = kWh;
    dataset.houseContributionPercent = percent;

    /*
      Show percentage directly in the legend.
      Example: Grid → Home [W] · 82 %
    */
    dataset.label = `${dataset.label} · ${percent.toFixed(0)} %`;
  }
}


function startOfLocalDay(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
}

function startOfLocalWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // Sunday = 0
  const diff = day === 0 ? -6 : 1 - day;

  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);

  return d.getTime();
}

function startOfLocalDay(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
}

function startOfLocalWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // Sunday = 0
  const diff = day === 0 ? -6 : 1 - day;

  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);

  return d.getTime();
}

function startOfLocalDay(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
}

function startOfLocalWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // Sunday = 0
  const diff = day === 0 ? -6 : 1 - day;

  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);

  return d.getTime();
}

function getNominalRangeBounds(rangeName) {
  const now = new Date();
  const end = now.getTime();

  switch (rangeName) {
    case "today": {
      const min = startOfLocalDay(now);
      return {
        min,
        max: end,
        spanMs: end - min,
      };
    }

    case "last24h": {
      const spanMs = 24 * 60 * 60 * 1000;
      return {
        min: end - spanMs,
        max: end,
        spanMs,
      };
    }

    case "currentWeek": {
      const min = startOfLocalWeekMonday(now);
      return {
        min,
        max: end,
        spanMs: end - min,
      };
    }

    case "last7d": {
      const spanMs = 7 * 24 * 60 * 60 * 1000;
      return {
        min: end - spanMs,
        max: end,
        spanMs,
      };
    }

    case "currentMonth": {
      const min = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      return {
        min,
        max: end,
        spanMs: end - min,
      };
    }

    case "last30d": {
      const spanMs = 30 * 24 * 60 * 60 * 1000;
      return {
        min: end - spanMs,
        max: end,
        spanMs,
      };
    }

    case "currentYear": {
      const min = new Date(now.getFullYear(), 0, 1).getTime();
      return {
        min,
        max: end,
        spanMs: end - min,
      };
    }

    case "last365d": {
      const spanMs = 365 * 24 * 60 * 60 * 1000;
      return {
        min: end - spanMs,
        max: end,
        spanMs,
      };
    }

    case "all":
    default:
      return {
        min: null,
        max: null,
        spanMs: null,
      };
  }
}

function getFilteredSnapshots() {
  const bounds = getNominalRangeBounds(state.chartRange);

  if (bounds.min === null) {
    return state.snapshots;
  }

  return state.snapshots.filter((snapshot) => {
    return snapshot.time >= bounds.min && snapshot.time <= bounds.max;
  });
}

/*
  This decides what the x-axis should display.

  If full range axis is enabled:
  - The selected duration is preserved.
  - But if the data does not cover the full range, the axis starts at the
    first available data point.
  - Therefore the empty part is on the right, not on the left.

  Example:
  Selected: Last 24h
  Data available: only last 2h
  Axis: first data timestamp → first data timestamp + 24h
*/
function getChartAxisBounds(filteredSnapshots) {
  const nominal = getNominalRangeBounds(state.chartRange);

  if (!state.chartFullRangeAxis) {
    return {
      min: null,
      max: null,
      spanMs: null,
    };
  }

  if (state.chartRange === "all") {
    return {
      min: null,
      max: null,
      spanMs: null,
    };
  }

  if (!filteredSnapshots.length) {
    return {
      min: nominal.min,
      max: nominal.max,
      spanMs: nominal.spanMs,
    };
  }

  const firstDataTime = filteredSnapshots[0].time;
  const axisMin = firstDataTime;
  const axisMax = firstDataTime + nominal.spanMs;

  return {
    min: axisMin,
    max: axisMax,
    spanMs: nominal.spanMs,
  };
}

function getDatasetTimeSpan(datasets) {
  let min = Infinity;
  let max = -Infinity;

  for (const dataset of datasets) {
    for (const point of dataset.data || []) {
      if (point.x < min) min = point.x;
      if (point.x > max) max = point.x;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }

  return Math.max(0, max - min);
}

function matchingKeysForSuffix(suffix) {
  return state.numericKeys.filter((key) => {
    return key === suffix || key.endsWith(`.${suffix}`);
  });
}

function resolveSeriesKey(suffixes) {
  for (const suffix of suffixes) {
    const matches = matchingKeysForSuffix(suffix);

    if (!matches.length) {
      continue;
    }

    // Prefer site-level values for system totals.
    const siteMatch = matches.find((key) => key.startsWith("sites."));
    if (siteMatch) {
      return siteMatch;
    }

    return matches[0];
  }

  return null;
}

function getChartSeriesDefinitions() {
  if (state.chartGroup === "custom") {
    return state.selectedKeys.map((key, index) => ({
      label: state.labels.get(key) || cleanLabel(key),
      key,
      unit: inferUnit(key),
      axis: axisForUnit(inferUnit(key)),
      color: COLORS[index % COLORS.length],
      cumulative: inferUnit(key) === "kWh",
    }));
  }

  const group = CHART_GROUPS[state.chartGroup] || CHART_GROUPS.overview;
  const definitions = [
    ...group.summary,
    ...(state.chartDetailed ? group.detail : []),
  ];

  return definitions
    .map((definition) => {
      const key = resolveSeriesKey(definition.suffixes);

      if (!key) {
        return null;
      }

      return {
        ...definition,
        key,
      };
    })
    .filter(Boolean);
}

function formatCompact(value, unit = "") {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  let formatted;

  if (Math.abs(value) >= 1000) {
    formatted = value.toFixed(0);
  } else if (Math.abs(value) >= 100) {
    formatted = value.toFixed(0);
  } else if (Math.abs(value) >= 10) {
    formatted = value.toFixed(1);
  } else {
    formatted = value.toFixed(2);
  }

  return `${formatted}${unit ? ` ${unit}` : ""}`;
}

function estimateEnergyKWh(points) {
  if (points.length < 2) return null;

  let wh = 0;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];

    const hours = (curr.x - prev.x) / 1000 / 60 / 60;
    const avgW = (prev.y + curr.y) / 2;

    if (hours > 0 && hours < 6) {
      wh += avgW * hours;
    }
  }

  return wh / 1000;
}

function seriesDelta(points) {
  if (points.length < 2) return null;

  return points.at(-1).y - points[0].y;
}

function renderChartInsights(datasets) {
  if (!datasets.length) {
    els.chartInsights.innerHTML = `
      <div class="insight-card muted">${escapeHtml(t("noChartData"))}</div>
    `;
    return;
  }

  els.chartInsights.innerHTML = datasets.slice(0, 8).map((dataset) => {
    const values = dataset.data.map((point) => point.y);
    const latest = values.at(-1);
    const max = Math.max(...values);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;

    let extra = "";

    if (dataset.axis === "power") {
      const estimated = estimateEnergyKWh(dataset.data);
      extra = estimated === null
        ? `${t("energyEstimate")}: —`
        : `${t("energyEstimate")}: ${formatCompact(estimated, "kWh")}`;
    } else if (dataset.cumulative) {
      const delta = seriesDelta(dataset.data);
      extra = delta === null
        ? `${t("delta")}: —`
        : `${t("delta")}: ${formatCompact(delta, dataset.unit)}`;
    } else {
      extra =
        `${t("avg")}: ${formatCompact(avg, dataset.unit)} · ` +
        `${t("max")}: ${formatCompact(max, dataset.unit)}`;
    }

    return `
      <div class="insight-card">
        <div class="insight-title" title="${escapeHtml(dataset.label)}">
          ${escapeHtml(dataset.label)}
        </div>
        <div class="insight-main">${escapeHtml(formatCompact(latest, dataset.unit))}</div>
        <div class="insight-sub">
        ${escapeHtml(t("avg"))} ${escapeHtml(formatCompact(avg, dataset.unit))} ·
        ${escapeHtml(t("max"))} ${escapeHtml(formatCompact(max, dataset.unit))}
        <br />
        ${escapeHtml(extra)}
        ${
            dataset.houseContributionPercent !== null &&
            dataset.houseContributionPercent !== undefined
            ? `<br />${escapeHtml(t("houseShare"))}: ${escapeHtml(dataset.houseContributionPercent.toFixed(1))} % · ${escapeHtml(formatCompact(dataset.houseContributionKWh, "kWh"))}`
            : ""
        }
        </div>
      </div>
    `;
  }).join("");
}

function updateChartControlState() {
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === state.chartRange);
  });

  document.querySelectorAll("[data-chart-group]").forEach((button) => {
    button.classList.toggle("active", button.dataset.chartGroup === state.chartGroup);
  });

  if (els.detailToggle) {
    els.detailToggle.checked = state.chartDetailed;
  }

  if (els.fullRangeToggle) {
    els.fullRangeToggle.checked = state.chartFullRangeAxis;
  }
  requestAnimationFrame(updateScrollableFades);
}

function updateChart() {
  syncHiddenSeriesFromChart();

  const snapshots = getFilteredSnapshots();
  const definitions = getChartSeriesDefinitions();
  const axisBounds = getChartAxisBounds(snapshots);

  const datasets = definitions
    .map((definition, index) => buildDataset(definition, index, snapshots))
    .filter((dataset) => dataset.data.length > 0);

  applyHouseContributionPercentages(datasets);

  const usedAxes = new Set(datasets.map((dataset) => dataset.yAxisID));

  const dataSpanMs = getDatasetTimeSpan(datasets);
  const visibleSpanMs =
    axisBounds.spanMs ||
    dataSpanMs ||
    24 * 60 * 60 * 1000;

  if (state.chart) {
    state.chart.destroy();
  }

  const compactChart = isCompactViewport();

  state.chart = new Chart(els.mainChart, {
    type: "line",
    data: {
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: {
        mode: "nearest",
        intersect: false,
      },
      plugins: {
        legend: {
            labels: {
                color: "#eaf4ff",
                usePointStyle: true,
                boxWidth: 8,
                boxHeight: 8,
            },
            onClick(event, legendItem, legend) {
                const chart = legend.chart;
                const datasetIndex = legendItem.datasetIndex;
                const dataset = chart.data.datasets[datasetIndex];

                if (!dataset) return;

                const currentlyVisible = chart.isDatasetVisible(datasetIndex);
                const nextVisible = !currentlyVisible;

                chart.setDatasetVisibility(datasetIndex, nextVisible);

                if (dataset.seriesId) {
                    if (nextVisible) {
                        state.hiddenSeries.delete(dataset.seriesId);
                    } else {
                        state.hiddenSeries.add(dataset.seriesId);
                    }
                }

                chart.update();
            },
        },
        tooltip: {
          backgroundColor: "rgba(3, 9, 22, 0.95)",
          borderColor: "rgba(94, 231, 255, 0.35)",
          borderWidth: 1,
          titleColor: "#ffffff",
          bodyColor: "#dcecff",
          callbacks: {
            title(items) {
              if (!items.length) return "";
              return new Date(items[0].parsed.x).toLocaleString();
            },
          },
        },
      },
      scales: {
        x: {
            type: "linear",

            ...(state.chartFullRangeAxis && axisBounds.min !== null
                ? { min: axisBounds.min }
                : {}),

            ...(state.chartFullRangeAxis && axisBounds.max !== null
                ? { max: axisBounds.max }
                : {}),

            ticks: {
                color: "#8394ad",
                maxRotation: 0,
                autoSkip: true,
                callback(value) {
                return formatXAxisTick(value, visibleSpanMs);
                },
            },

            grid: {
                color: "rgba(130, 180, 255, 0.08)",
            },
        },

        power: {
            display: usedAxes.has("power"),
            position: "left",
            title: {
                display: !compactChart && usedAxes.has("power"),
                text: t("powerAxis"),
                color: "#8394ad",
            },
            ticks: {
                color: "#8394ad",
                maxTicksLimit: compactChart ? 4 : 8,
                padding: compactChart ? 2 : 6,
                callback(value) {
                return compactChart ? formatAxisTick(value) : value;
                },
            },
            grid: {
                color: "rgba(130, 180, 255, 0.08)",
            },
        },

        percent: {
            display: usedAxes.has("percent"),
            position: "right",
            min: 0,
            max: 100,
            title: {
                display: !compactChart && usedAxes.has("percent"),
                text: t("socAxis"),
                color: "#8394ad",
            },
            ticks: {
                color: "#8394ad",
                maxTicksLimit: compactChart ? 4 : 8,
                padding: compactChart ? 2 : 6,
                callback(value) {
                return compactChart ? formatAxisTick(value) : value;
                },
            },
            grid: {
                drawOnChartArea: false,
            },
        },

        energy: {
            display: usedAxes.has("energy"),
            position: "right",
            title: {
                display: !compactChart && usedAxes.has("energy"),
                text: t("energyAxis"),
                color: "#8394ad",
            },
            ticks: {
                color: "#8394ad",
                maxTicksLimit: compactChart ? 4 : 8,
                padding: compactChart ? 2 : 6,
                callback(value) {
                return compactChart ? formatAxisTick(value) : value;
                },
            },
            grid: {
                drawOnChartArea: false,
            },
        },
      },
    },
  });

  renderChartInsights(datasets);
  updateChartControlState();
}

function renderMetricList() {
  const query = els.metricSearch.value.trim().toLowerCase();

  const keys = state.numericKeys.filter((key) => {
    const label = state.labels.get(key) || key;

    return (
      !query ||
      key.toLowerCase().includes(query) ||
      label.toLowerCase().includes(query)
    );
  });

  if (!keys.length) {
    els.metricList.innerHTML =
  `<div class="metric-item">${escapeHtml(t("noMetricsFound"))}</div>`;
    return;
  }

  els.metricList.innerHTML = keys.map((key) => {
    const checked = state.selectedKeys.includes(key) ? "checked" : "";
    const label = state.labels.get(key) || key;
    const unit = inferUnit(key) || t("value");

    return `
      <label class="metric-item" title="${escapeHtml(key)}">
        <input type="checkbox" data-key="${escapeHtml(key)}" ${checked} />

        <span>
          <div class="metric-title">${escapeHtml(label)}</div>
        </span>

        <span class="metric-unit">${escapeHtml(unit)}</span>
      </label>
    `;
  }).join("");

  els.metricList.querySelectorAll("input").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const key = checkbox.dataset.key;

      if (checkbox.checked) {
        if (!state.selectedKeys.includes(key)) {
          state.selectedKeys.push(key);
        }
      } else {
        state.selectedKeys = state.selectedKeys.filter((item) => item !== key);
      }

      /*
        If at least one advanced metric is selected, switch to custom mode.
        If none are selected anymore, automatically return to Overview.
      */
      if (state.selectedKeys.length > 0) {
        state.chartGroup = "custom";
      } else {
        state.chartGroup = "overview";
      }

      updateChart();
      renderMetricList();
    });
  });
}

function loadText(text, sourceName = "JSONL") {
  const parsed = parseJsonl(text);

  state.records = parsed.records;
  state.snapshots = parsed.snapshots;
  state.finalState = parsed.finalState;
  state.numericKeys = parsed.numericKeys;

  buildLabels();
  updateDashboard();

  const first = state.snapshots[0];
  const last = state.snapshots.at(-1);

  els.subtitle.textContent =
  `${state.records.length} ${t("records")} · ` +
  `${state.numericKeys.length} ${t("numericMetrics")}`;
  els.timeRange.textContent = `${new Date(first.time).toLocaleString()} → ${new Date(last.time).toLocaleString()}`;

  setStatus(`${t("onlineWatching")} ${sourceName}`, "ok");

  updateChart();

  updateFlowLines();
}

function readFile(file) {
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      loadText(String(reader.result || ""), file.name);
      hideManualLoadButton();
    } catch (error) {
      console.error(error);
      setStatus(`${t("error")}: ${error.message}`, "error");
      showManualLoadButton();
    }
  };

  reader.readAsText(file);
}

async function loadDefaultFromExports({ force = false, silent = false } = {}) {
  if (state.isLoadingRemote) return;

  state.isLoadingRemote = true;

  try {
    const monthKeys = await monthKeysForCurrentRange();

    if (!monthKeys.length) {
      throw new Error("No monthly export files configured.");
    }

    const firstMonth = monthKeys[0];
    const lastMonth = monthKeys.at(-1);

    if (!silent) {
      setStatus(
        `${t("loading")} ${monthlyRootPath()} ${firstMonth} → ${lastMonth} ...`
      );
    }

    const texts = [];

    for (const monthKey of monthKeys) {
      /*
        Required:
        - current month
        - last selected month if no data has been loaded yet

        Other historical months are optional because they may simply not exist.
      */
      const text = await fetchMonthlyJsonl(monthKey, {
        force,
        required: false,
        });

      if (text && text.trim()) {
        texts.push({
          monthKey,
          text,
        });
      }
    }

    if (!texts.length) {
      /*
        Optional backwards compatibility:
        If no monthly files were found, try the old single JSONL file.
      */
      const legacyText = await fetchLegacyJsonl();
      const legacyHash = hashText(legacyText);

      if (
        !force &&
        state.lastContentHash &&
        legacyHash === state.lastContentHash
      ) {
        return;
      }

      loadText(legacyText, LEGACY_JSONL_PATH);
      state.lastContentHash = legacyHash;

      hideManualLoadButton();
      return;
    }

    /*
      Files are combined in month order.
      Each month starts with a full record, so every month remains independent.
    */
    texts.sort((a, b) => a.monthKey.localeCompare(b.monthKey));

    const combinedText = texts
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n");

    const contentHash = hashText(
      texts
        .map((item) => `${item.monthKey}:${hashText(item.text)}`)
        .join("|")
    );

    if (
      !force &&
      state.lastContentHash &&
      contentHash === state.lastContentHash
    ) {
      return;
    }

    const sourceName =
      texts.length === 1
        ? monthlyJsonlPath(texts[0].monthKey)
        : `${monthlyRootPath()} ${texts[0].monthKey} → ${texts.at(-1).monthKey}`;

    loadText(combinedText, sourceName);

    state.lastContentHash = contentHash;

    hideManualLoadButton();
  } catch (error) {
    console.error(error);

    if (!state.records.length) {
      setStatus(
        `${t("couldNotLoad")} ${monthlyRootPath()}. ` +
        `${t("browserUrl")}: ${window.location.href}. ` +
        `${t("tryOpenDirectly")}`,
        "error"
      );

      showManualLoadButton();
    } else {
      setStatus(
        `${t("usingLastData")} ${monthlyRootPath()} ...`,
        "neutral"
      );
    }
  } finally {
    state.isLoadingRemote = false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initEvents() {
  els.fileInput.addEventListener("change", () => {
    readFile(els.fileInput.files?.[0]);
  });

  els.metricSearch.addEventListener("input", renderMetricList);

  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      selectChartRange(button.dataset.range);
    });
  });

  document.querySelectorAll("[data-chart-group]").forEach((button) => {
    button.addEventListener("click", () => {
      selectChartGroup(button.dataset.chartGroup);
    });
  });

  els.detailToggle.addEventListener("change", () => {
    state.chartDetailed = els.detailToggle.checked;
    updateChart();
  });

  els.fullRangeToggle.addEventListener("change", () => {
    state.chartFullRangeAxis = els.fullRangeToggle.checked;
    updateChart();
  });
  document.querySelectorAll(".chart-tabs").forEach((tabs) => {
    tabs.addEventListener("scroll", updateScrollableFades, {
      passive: true,
    });
  });

  window.addEventListener("resize", updateScrollableFades);
  document.querySelectorAll("[data-language-switch]").forEach((button) => {
    button.addEventListener("click", () => {
        const language = normalizeLanguage(button.dataset.languageSwitch);

        if (!AVAILABLE_LANGUAGES.includes(language)) {
            return;
        }

        currentLanguage = language;
        localStorage.setItem("solar-monitor-language", language);

        const url = new URL(window.location.href);
        url.searchParams.set("lang", language);
        window.history.replaceState({}, "", url);
        
        applyTranslations();
        updateDashboard();
        updateChart();
        renderMetricList();
    });   
  });
  let chartResizeTimer = null;

  window.addEventListener("resize", () => {
    clearTimeout(chartResizeTimer);

    chartResizeTimer = setTimeout(() => {
        updateChart();
        updateFlowLines();
        updateScrollableFades();
    }, 150);
  });
}

applyTranslations();

initEvents();

requestAnimationFrame(updateScrollableFades);
setTimeout(updateScrollableFades, 250);

loadDefaultFromExports({
  force: true,
  silent: false,
});

setInterval(() => {
  loadDefaultFromExports({
    force: false,
    silent: true,
  });
}, WATCH_INTERVAL_MS);
