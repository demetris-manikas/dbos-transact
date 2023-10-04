#!/usr/bin/env node

import { parseConfigFile } from "./config";
import { deploy } from "./deploy";
import { OperonRuntime, OperonRuntimeConfig } from "./runtime";
import { Command } from 'commander';
import { OperonConfig } from "../operon";
const program = new Command();

/* LOCAL DEVELOPMENT */
program
  .command('start')
  .description('Start the server')
  .option('-p, --port <type>', 'Specify the port number')
  .action(async (options: { port: string }) => {
    const [operonConfig, runtimeConfig]: [OperonConfig, OperonRuntimeConfig | undefined] = parseConfigFile();
    const runtime = new OperonRuntime(operonConfig, runtimeConfig);
    await runtime.init();
    runtime.startServer({
      port: parseInt(options.port),
    });
  });

/* CLOUD DEPLOYMENT */
program
  .command('deploy')
  .description('Deploy an application to the cloud')
  .option('-n, --name <type>', 'Specify the app name')
  .option('-h, --host <type>', 'Specify the host', 'localhost')
  .action(async (options: { name: string, host: string }) => {
    if (!options.name) {
      console.error('Error: the --name option is required.');
      return;
    }
    await deploy(options.name, options.host);
  });

program.parse(process.argv);

// If no arguments provided, display help by default
if (!process.argv.slice(2).length) {
  program.outputHelp();
}