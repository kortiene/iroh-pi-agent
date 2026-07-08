/**
 * Data model for the read-only Room Cockpit (Phase 1).
 *
 * The cockpit renders immutable snapshots supplied by AmbientController. Room
 * strings in this model are still untrusted; renderers must pass them through
 * roomText() before display.
 */

export const COCKPIT_TABS = ["overview", "timeline", "tasks", "members", "pipes", "health"] as const;

export type CockpitTab = (typeof COCKPIT_TABS)[number];

export type CockpitFeedState = "ok" | "stale" | "failing" | "broken_config" | "unconfigured";

export interface AgentStatusSummary {
	label: string;
	progress?: number;
	message?: string;
	author?: string;
	timestamp?: string;
	eventId?: string;
}

export interface TimelineEvent {
	eventId?: string;
	type: string;
	author?: string;
	timestamp?: string;
	lamport?: number;
	summary: string;
}

export interface TaskSummary {
	id: string;
	type: string;
	title: string;
	state: "backlog" | "claimed" | "ready_for_review" | "done";
}

export interface MemberSummary {
	id: string;
	role: string;
	status?: string;
	isAdmin?: boolean;
}

export interface FileSummary {
	id?: string;
	name?: string;
	sizeBytes?: number;
	mime?: string;
	provider?: string;
}

export interface PipeSummary {
	id: string;
	target: string;
	label?: string;
	state: "open" | "closed" | "unknown";
	trustedLocal: boolean;
	startedAt?: number;
}

export interface CockpitSnapshot {
	config: {
		roomId?: string;
		roomLabel?: string;
		binary?: string;
		dataDir?: string;
		agentName?: string;
		configFile?: string;
		cwd?: string;
	};

	identity?: {
		name: string;
		identityId: string;
		from8: string;
		deviceId?: string;
	};

	feed: {
		state: CockpitFeedState;
		lastOkAt?: number;
		nextRetryAt?: number;
		failure?: string;
		gap: boolean;
		rowCount?: number;
		seenCount?: number;
	};

	latest: {
		status?: AgentStatusSummary;
		event?: TimelineEvent;
	};

	tasks: {
		all: TaskSummary[];
		unclaimed: TaskSummary[];
		claimed: TaskSummary[];
		readyForReview: TaskSummary[];
		done: TaskSummary[];
	};

	members: MemberSummary[];
	files: FileSummary[];
	pipes: PipeSummary[];
	events: TimelineEvent[];
}

export interface CockpitDataSource {
	getSnapshot(): CockpitSnapshot;
	requestRefresh(): Promise<void>;
	subscribe(listener: () => void): () => void;
}

export interface CockpitKeyRouter {
	isClose(data: string): boolean;
	isHelp(data: string): boolean;
	isNextTab(data: string): boolean;
	isPrevTab(data: string): boolean;
	isUp(data: string): boolean;
	isDown(data: string): boolean;
	isRefresh(data: string): boolean;
	isEnter(data: string): boolean;
	isReadOnlyAction(data: string): boolean;
	tabFor(data: string): CockpitTab | undefined;
}
