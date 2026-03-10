import {
  buildStatusPayload,
  commandDoctor,
  commandInit,
  commandValidateConfig,
  printHelp,
  printStatus,
} from './lib/ado-cli-bootstrap.js';
import { commandInstall, commandUninstall } from './lib/ado-cli-install.js';
import {
  commandAudit,
  commandList,
  commandNext,
  commandReport,
  commandRetag,
} from './lib/ado-cli-reporting.js';
import {
  commandBranch,
  commandClaim,
  commandCommit,
  commandCreate,
  commandDisable,
  commandDone,
  commandEnable,
  commandLink,
  commandPr,
  commandPrioritize,
  commandStart,
} from './lib/ado-cli-workflow.js';
import { fail, loadConfig } from './lib/ado-cli-runtime.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = argv.slice(1);

  switch (command) {
    case 'status':
      printStatus(args);
      return;
    case 'validate-config':
      commandValidateConfig(args);
      return;
    case 'install':
      commandInstall(args);
      return;
    case 'uninstall':
      commandUninstall(args);
      return;
    case 'init':
      await commandInit(args);
      return;
    case 'doctor':
      commandDoctor(args);
      return;
    case 'smoke':
      commandDoctor(['--smoke', ...args]);
      return;
    case 'enable':
      commandEnable(loadConfig(), args);
      return;
    case 'disable':
      commandDisable(loadConfig(), args);
      return;
    case 'create':
      commandCreate(loadConfig(), args);
      return;
    case 'claim':
      commandClaim(loadConfig(), args);
      return;
    case 'start':
      commandStart(loadConfig(), args);
      return;
    case 'prioritize':
      commandPrioritize(loadConfig(), args);
      return;
    case 'link':
      commandLink(loadConfig(), args);
      return;
    case 'branch':
      commandBranch(loadConfig(), args);
      return;
    case 'commit':
      commandCommit(loadConfig(), args);
      return;
    case 'pr':
      commandPr(loadConfig(), args);
      return;
    case 'done':
      commandDone(loadConfig(), args);
      return;
    case 'retag':
      commandRetag(loadConfig(), args);
      return;
    case 'list':
      commandList(loadConfig(), args);
      return;
    case 'next':
      commandNext(loadConfig(), args);
      return;
    case 'audit':
      commandAudit(loadConfig(), args);
      return;
    case 'report':
      commandReport(loadConfig(), args);
      return;
    default:
      printHelp();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});

export { buildStatusPayload };
