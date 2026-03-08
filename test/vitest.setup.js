/**
 * Vitest setup file — makes the sigplot bundle available globally,
 * matching how QUnit tests expect it (via <script> tag in HTML runner).
 */

// Import the built bundle
import sigplot from "../js/sigplot.js";

// Make it globally available (mimics the HTML <script> include)
globalThis.sigplot = sigplot;
