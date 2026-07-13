export type Agent = 'mock' | 'claude-code' | 'codex';

export interface Profile {
  id: string;
  name: string;
  email: string;
}

export interface Settings {
  defaultTokenBudget: number;
  maxConcurrentRuns: number;
  phaseTimeoutMinutes: number;
  telegramConfigured: boolean;
  telegramToken?: string;
}

export interface TaskAutoRun {
  plan: boolean;
  execution: boolean;
  review: boolean;
  tests: boolean;
}

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  totalTokens: number;
}

export interface TaskBudget {
  tokens: number;
}

export interface Task {
  id: string;
  projectId?: string;
  name: string;
  description: string;
  status: string;
  runStatus?: string;
  updatedAt: number;
  requirements: string[];
  branch: string;
  planAccepted?: boolean;
  notes?: string;
  priority?: string;
  workspace?: string;
  llmProcessId?: string | null;
  currentPhase?: string;
  attempts?: number;
  maxAttempts?: number;
  autoRun?: TaskAutoRun;
  usage?: TaskUsage;
  budget?: TaskBudget;
  createdAt?: number;
  // Present only on dashboard `active` entries (the api joins in the project name).
  projectName?: string;
}

export interface Skill {
  id: string;
  name: string;
  instructions: string;
  enabled?: boolean;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  addedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  agent: Agent;
  agentLabel: string;
  provider?: string;
  permissionMode?: string;
  branch: string;
  health: string;
  tasks: Task[];
  skills?: Skill[];
  knowledge?: KnowledgeDoc[];
  // Present only on the `/api/projects` list view (not the `/api/projects/:id` detail view).
  taskCount?: number;
  createdAt?: number;
  latestTask?: Task | null;
}

export interface Dashboard {
  runningNow: number;
  tasksTracked: number;
  projectCount: number;
  active: Task[];
}
