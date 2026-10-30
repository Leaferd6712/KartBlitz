import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'launch.spec.mjs',workers:1,timeout:60000,use:{trace:'retain-on-failure'},outputDir:'../test-results/desktop'});
