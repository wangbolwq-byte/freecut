const GLOBAL_OPTIONS = ['--workspace', '--json']
const BROWSER_OPTIONS = ['--build', '--harness-url', '--head']
const WRITER_OPTIONS = ['--break-lock']

function command({
  path,
  summary,
  options = [],
  flags = [],
  required = [],
  examples,
  internalOptions = [],
}) {
  const allowedOptions = [...new Set([...options, ...GLOBAL_OPTIONS, ...internalOptions])]
  return Object.freeze({
    key: path.join(' '),
    path: Object.freeze(path),
    summary,
    allowedOptions: Object.freeze(allowedOptions),
    booleanOptions: Object.freeze([...new Set([...flags, '--json', '--head', '--break-lock'])]),
    requiredOptions: Object.freeze(required),
    examples: Object.freeze(examples.slice(0, 8).map((example) => Object.freeze(example))),
  })
}

export const AUTOCUT_AGENT_COMMAND_CONTRACTS = Object.freeze({
  capabilities: command({
    path: ['capabilities'],
    summary: 'Inspect the available AutoCut operations and runtime capabilities.',
    options: ['--compact'],
    flags: ['--compact'],
    examples: [
      {
        description: 'Read the compact Agent-facing capabilities.',
        command: 'autocut-agent capabilities --compact',
      },
    ],
  }),
  'editor-url': command({
    path: ['editor-url'],
    summary: 'Create the authenticated built-in editor URL for a project or project list.',
    options: ['--id'],
    examples: [
      {
        description: 'Open one project in the built-in editor.',
        command: 'autocut-agent editor-url --id <project-id> --json',
      },
    ],
  }),
  'project list': command({
    path: ['project', 'list'],
    summary: 'List projects in the injected AutoCut workspace.',
    examples: [{ description: 'List projects.', command: 'autocut-agent project list' }],
  }),
  'project get': command({
    path: ['project', 'get'],
    summary: 'Read a project and its current revision.',
    options: ['--id'],
    required: ['--id'],
    examples: [
      {
        description: 'Read a project before a revision-safe write.',
        command: 'autocut-agent project get --id <project-id>',
      },
    ],
  }),
  'project audit': command({
    path: ['project', 'audit'],
    summary:
      'Read-only remix integrity audit. ok=false and exit 1 mean rules failed, not execution failure. Facts are observations, not errors; passing does not verify visual, audio, or render quality.',
    options: ['--id', '--mode', '--track-id'],
    required: ['--id'],
    examples: [
      {
        description: 'Audit the complete project.',
        command: 'autocut-agent project audit --id <project-id> --mode remix',
      },
      {
        description: 'Audit one selected track.',
        command: 'autocut-agent project audit --id <project-id> --mode remix --track-id <track-id>',
      },
    ],
  }),
  'project create': command({
    path: ['project', 'create'],
    summary: 'Create a normalized editable AutoCut project.',
    options: [
      '--id',
      '--name',
      '--description',
      '--width',
      '--height',
      '--fps',
      '--background-color',
    ],
    required: ['--name'],
    internalOptions: [...BROWSER_OPTIONS, ...WRITER_OPTIONS],
    examples: [
      {
        description: 'Create a standard project.',
        command: 'autocut-agent project create --id demo --name "Demo"',
      },
    ],
  }),
  'project save': command({
    path: ['project', 'save'],
    summary: 'Replace a project from a JSON file with revision protection.',
    options: ['--id', '--file', '--expected-revision', '--force'],
    flags: ['--force'],
    required: ['--id', '--file'],
    internalOptions: [...BROWSER_OPTIONS, ...WRITER_OPTIONS],
    examples: [
      {
        description: 'Save a project using the current revision.',
        command:
          'autocut-agent project save --id <project-id> --file <project.json> --expected-revision <revision>',
      },
    ],
  }),
  'project update': command({
    path: ['project', 'update'],
    summary: 'Update project metadata and settings with revision protection.',
    options: [
      '--id',
      '--name',
      '--description',
      '--width',
      '--height',
      '--fps',
      '--background-color',
      '--expected-revision',
      '--force',
    ],
    flags: ['--force'],
    required: ['--id'],
    internalOptions: [...BROWSER_OPTIONS, ...WRITER_OPTIONS],
    examples: [
      {
        description: 'Rename a project using the current revision.',
        command:
          'autocut-agent project update --id <project-id> --name "New name" --expected-revision <revision>',
      },
    ],
  }),
  'project edit': command({
    path: ['project', 'edit'],
    summary:
      'Apply an operations JSON file as one atomic revision-safe edit. Use a stable idempotency key to safely replay the same batch after response loss. sourceStart/sourceEnd are source frames, not seconds; from/durationInFrames use project FPS.',
    options: ['--id', '--ops', '--persist', '--expected-revision', '--force', '--idempotency-key'],
    flags: ['--persist', '--force'],
    required: ['--id', '--ops'],
    internalOptions: [...BROWSER_OPTIONS, ...WRITER_OPTIONS],
    examples: [
      {
        description: 'Persist one atomic edit using the current revision.',
        command:
          'autocut-agent project edit --id <project-id> --ops <operations.json> --persist --expected-revision <revision>',
      },
      {
        description: 'Read the current project and revision before retrying.',
        command: 'autocut-agent project get --id <project-id>',
      },
      {
        description:
          'Persist a replay-safe batch. Retry with identical key and operations; use a new key for a new logical edit.',
        command:
          'autocut-agent project edit --id <project-id> --ops <operations.json> --persist --expected-revision <revision> --idempotency-key <stable-batch-key>',
      },
    ],
  }),
  'media list': command({
    path: ['media', 'list'],
    summary: 'List media in the injected AutoCut workspace.',
    examples: [{ description: 'List media.', command: 'autocut-agent media list' }],
  }),
  'media get': command({
    path: ['media', 'get'],
    summary: 'Read one media resource and its metadata.',
    options: ['--id'],
    required: ['--id'],
    examples: [
      { description: 'Read imported media.', command: 'autocut-agent media get --id <media-id>' },
    ],
  }),
  'media probe': command({
    path: ['media', 'probe'],
    summary: 'Probe media metadata, optionally persisting it with revision protection.',
    options: ['--id', '--persist', '--expected-revision', '--force'],
    flags: ['--persist', '--force'],
    required: ['--id'],
    internalOptions: [...BROWSER_OPTIONS, ...WRITER_OPTIONS],
    examples: [
      {
        description: 'Probe and persist media metadata.',
        command:
          'autocut-agent media probe --id <media-id> --persist --expected-revision <revision>',
      },
    ],
  }),
  'media import': command({
    path: ['media', 'import'],
    summary: 'Import a local media file and optionally associate it with a project.',
    options: ['--file', '--id', '--project'],
    required: ['--file'],
    internalOptions: [...BROWSER_OPTIONS, ...WRITER_OPTIONS],
    examples: [
      {
        description: 'Import media for a project.',
        command: 'autocut-agent media import --file <media-path> --project <project-id>',
      },
    ],
  }),
  render: command({
    path: ['render'],
    summary: 'Render a persisted project to an output inside the AutoCut workspace.',
    options: [
      '--project',
      '--out',
      '--codec',
      '--container',
      '--resolution',
      '--fps',
      '--quality',
      '--preset',
      '--duration',
      '--in',
      '--out-sec',
      '--audio-only',
      '--allow-missing-media',
    ],
    flags: ['--audio-only', '--allow-missing-media'],
    required: ['--project'],
    internalOptions: BROWSER_OPTIONS,
    examples: [
      {
        description: 'Render a draft preview inside the workspace.',
        command:
          'autocut-agent render --project <project-id> --out projects/<project-id>/renders/preview.mp4 --preset draft',
      },
      {
        description: 'Render the final deliverable inside the workspace.',
        command:
          'autocut-agent render --project <project-id> --out projects/<project-id>/renders/final.mp4 --preset final',
      },
    ],
  }),
  'render submit': command({
    path: ['render', 'submit'],
    summary: 'Submit a Host-managed render that keeps running after this terminal command exits.',
    options: [
      '--project',
      '--out',
      '--codec',
      '--container',
      '--resolution',
      '--fps',
      '--quality',
      '--preset',
      '--duration',
      '--in',
      '--out-sec',
      '--audio-only',
      '--allow-missing-media',
    ],
    flags: ['--audio-only', '--allow-missing-media'],
    required: ['--project'],
    examples: [
      {
        description: 'Submit a durable background render.',
        command:
          'autocut-agent render submit --project <project-id> --out projects/<project-id>/renders/final.mp4 --preset final',
      },
    ],
  }),
  'render status': command({
    path: ['render', 'status'],
    summary: 'Read the current Host-managed render status and progress.',
    options: ['--ref'],
    required: ['--ref'],
    examples: [
      {
        description: 'Read render progress.',
        command: 'autocut-agent render status --ref <autocut-render-ref>',
      },
    ],
  }),
  'render output': command({
    path: ['render', 'output'],
    summary: 'Read the verified output of a completed Host-managed render.',
    options: ['--ref'],
    required: ['--ref'],
    examples: [
      {
        description: 'Read a completed render output.',
        command: 'autocut-agent render output --ref <autocut-render-ref>',
      },
    ],
  }),
  'render cancel': command({
    path: ['render', 'cancel'],
    summary: 'Explicitly cancel a Host-managed render.',
    options: ['--ref'],
    required: ['--ref'],
    examples: [
      {
        description: 'Cancel a render.',
        command: 'autocut-agent render cancel --ref <autocut-render-ref>',
      },
    ],
  }),
  'remotion-render': command({
    path: ['remotion-render'],
    summary:
      'Render one controlled transparent animation from its task.json without creating a project.',
    options: ['--task'],
    required: ['--task'],
    examples: [
      {
        description: 'Render a standalone transparent animation.',
        command: 'remotion-render --task <task.json>',
      },
    ],
  }),
})

const ROOT_COMMANDS = Object.freeze([
  'capabilities',
  'editor-url',
  'project',
  'media',
  'render',
  'remotion-render',
])

function commandContract(commandKey) {
  return AUTOCUT_AGENT_COMMAND_CONTRACTS[commandKey]
}

export function canonicalCommands() {
  return Object.fromEntries(
    Object.entries(AUTOCUT_AGENT_COMMAND_CONTRACTS).map(([key, contract]) => [
      key,
      contract.examples[0].command,
    ]),
  )
}

export function commandHelp(contract) {
  return {
    command: contract.key,
    summary: contract.summary,
    allowedOptions: contract.allowedOptions,
    requiredOptions: contract.requiredOptions,
    canonicalCommand: contract.examples[0].command,
    examples: contract.examples,
  }
}

function groupHelp(group) {
  const contracts = Object.values(AUTOCUT_AGENT_COMMAND_CONTRACTS).filter(
    (contract) => group === undefined || contract.path[0] === group,
  )
  return {
    command: group ?? 'autocut-agent',
    summary: group ? `Available ${group} commands.` : 'Available AutoCut Agent command groups.',
    commands: group ? contracts.map((contract) => contract.key) : ROOT_COMMANDS,
    commandDetails: contracts.map(commandHelp),
    examples: contracts.flatMap((contract) => contract.examples),
  }
}

export function normalizeCommandArgv(argv) {
  if (argv[0] === 'help') return [...argv.slice(1), '--help']
  if (argv.length === 1 && argv[0] === '-h') return ['--help']
  if (argv.at(-1) === 'help' || argv.at(-1) === '-h') {
    const target = argv.slice(0, -1)
    const commandKey = target.join(' ')
    if (ROOT_COMMANDS.includes(commandKey) || commandContract(commandKey)) {
      return [...target, '--help']
    }
  }
  return argv
}

export function resolveCommand(argv) {
  const first = argv[0]
  if (!first || first === '--help') return { kind: 'help', help: groupHelp() }
  if (first === 'project' || first === 'media' || first === 'render') {
    const second = argv[1]
    if (first === 'render' && (!second || second.startsWith('-'))) {
      return { kind: 'command', contract: commandContract('render') }
    }
    if (!second || second === '--help') return { kind: 'help', help: groupHelp(first) }
    const contract = commandContract(`${first} ${second}`)
    if (contract) return { kind: 'command', contract }
    return {
      kind: 'unknown',
      command: `${first} ${second}`,
      candidates: Object.keys(AUTOCUT_AGENT_COMMAND_CONTRACTS).filter((key) =>
        key.startsWith(`${first} `),
      ),
      help: groupHelp(first),
    }
  }
  const contract = commandContract(first)
  if (contract) return { kind: 'command', contract }
  return {
    kind: 'unknown',
    command: first,
    candidates: ROOT_COMMANDS,
    help: groupHelp(),
  }
}

export function optionNames(contract) {
  return new Set(contract.allowedOptions.map((option) => option.slice(2)).concat('help'))
}

export function correctExamples(contract, extraExamples = []) {
  const examples = [...extraExamples, ...contract.examples]
  const truncated = examples.length > 8
  return {
    correctExamples: examples.slice(0, 8),
    ...(truncated ? { correctExamplesTruncated: true } : {}),
  }
}
