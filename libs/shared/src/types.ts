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

export interface Task {
  id: string;
  name: string;
  description: string;
  status: string;
  runStatus?: string;
  updatedAt: number;
  requirements: string[];
  branch: string;
  planAccepted?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  agent: Agent;
  agentLabel: string;
  branch: string;
  health: string;
  tasks: Task[];
}

export interface Dashboard {
  runningNow: number;
  tasksTracked: number;
  projectCount: number;
  active: Task[];
}
