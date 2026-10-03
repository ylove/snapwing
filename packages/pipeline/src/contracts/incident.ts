// Data contracts: main spec section 13.

export type IncidentUrgency = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
export type ActorRole = 'engineer' | 'reporter' | 'unknown';

export interface IncidentActor {
  id: string;
  name: string;
  email?: string;
  role: ActorRole;                 // resolved from workspace map
}

export interface SourceMessage {
  id: string;                      // ts, activity id, or synthetic
  authorId: string;
  text: string;
  timestamp: string;               // ISO 8601
  threadParentId?: string;
  replyCount?: number;             // Slack reply_count, Teams replies when known; absent means the adapter cannot tell
  mentions: string[];
  reactions: string[];
  attachments: Attachment[];
}

export interface Attachment {
  kind: 'image' | 'file' | 'link';
  url: string;
  mimeType?: string;
  extractedText?: string;          // unfurl output for links and files
  reading?: ImageReading;          // vision pass output for images (5.2a)
  recording?: RecordingReading;    // screen recording reading, or the note why it was not read (A 5.1)
}

export interface RecordingFrame {
  /** Seconds from the start of the recording. */
  seconds: number;
  reading: ImageReading;
}

export interface SequenceEntry {
  seconds: number;
  /** "0:04". */
  time: string;
  text: string;
}

export type RecordingReading =
  | {
      status: 'read';
      durationSeconds: number;
      frames: RecordingFrame[];
      sequence: SequenceEntry[];
      summary: string;
      note?: string;
    }
  | { status: 'skipped'; note: string };

/** A sign in a screenshot that the cause may be on the reporter's side (spec A 5.1). */
export type UserSideKind =
  | 'wrong-environment' | 'wrong-account' | 'stale-cache' | 'extension-interference'
  | 'input-mode' | 'expired-session' | 'network' | 'wrong-surface' | 'other';

export interface UserSideIndicator {
  kind: UserSideKind;
  evidence: string;                // "URL bar shows staging.example.com"
  confidence: number;              // 0..1
}

export interface ImageReading {
  errorText?: string;              // verbatim, if visible
  surfaceSignals: { urlBar?: string; pageTitle?: string; chrome?: 'web' | 'mobile' | 'desktop' | 'admin' | 'unknown' };
  uiElements: string[];            // visible labels, menu items, field names
  environmentHint?: 'production' | 'staging' | 'local' | 'unknown';
  plainDescription: string;        // reporter-facing: "the total field is blank"
  sensitive: boolean;              // credentials, tokens, or personal data visible
  userSideIndicators?: UserSideIndicator[]; // A 5.1; absent on readings recorded before it existed
}

export type ChannelSource = 'slack' | 'teams' | 'raycast' | 'cli' | 'alert_webhook';

export interface ContextBundle {
  anchorId: string;
  included: SourceMessage[];
  excluded: { id: string; reason: string }[];
  resolutionSignal?: { messageId: string; text: string };
  windowUsed: { oldest: string; latest: string; cap: number };
}

export interface Resolution {
  surfaceId?: string;
  componentId?: string;
  ownerId?: string;
  repo?: string;
  jiraProject?: string;
  resolvedBy: 'mention' | 'channel-explicit' | 'vocabulary' | 'image' | 'channel-inferred' | 'alert' | 'llm' | 'clarify' | 'unresolved';
  confidence: number;              // 0..1
}

export interface CanonicalIncidentPayload {
  eventId: string;                 // ULID
  idempotencyKey: string;
  source: ChannelSource;
  reporter: IncidentActor;
  /**
   * Spec silent (#363). Who wrote the anchor message, when that is a person other than `reporter`:
   * an engineer's trigger reaction or message action on a reporter's post. The incident's reporter
   * (`IncidentView.reporterId`, the one asked to check staging, A 4.4) is this person when present.
   */
  anchorAuthor?: IncidentActor;
  anchorText: string;
  context: {
    channelId: string;
    threadId?: string;
    deepLink?: string;
    rawPayloadSnapshot: Record<string, unknown>;
  };
  timestamp: string;
}

export interface DedupeResult {
  candidates: { issueKey: string; summary: string; score: number; assignee?: string }[];
  decision: 'none' | 'link' | 'create-anyway' | 'pending-user';
}

export interface ClarifyQuestion {
  audience: 'reporter' | 'engineer';
  text: string;
  options?: string[];              // 2..4, or omitted for screenshot request
  asks?: 'surface' | 'component' | 'environment' | 'symptom' | 'other'; // what it is about; a surface or component answer re-resolves
  gatePassed: boolean;
  gateFailures: string[];
}

export interface TriageResolutionPlan {
  action: 'create_issue' | 'link_existing' | 'noop';
  linkTo?: string;
  projectKey: string;
  issueType: 'Incident' | 'Bug' | 'Task';
  summary: string;
  descriptionAdf: Record<string, unknown>;
  priority: 'Lowest' | 'Low' | 'Medium' | 'High' | 'Highest';
  labels: string[];
  componentId?: string;
  suggestedAssigneeEmail?: string;
  diagnosis?: { confidence: 'low' | 'medium' | 'high'; files: { path: string; note: string }[] };
  implementationPromptXml?: string;
  autonomyLevel: 0 | 1 | 2 | 3;    // resolved from policy for this incident
}

export type ApprovalAction = 'approve_fix' | 'ticket_only' | 'dismiss' | 'stop' | 'merge' | 'request_changes' | 'revert';

export interface MergeGateResult {
  reviewVerdict: 'approve' | 'request-changes' | 'escalate';
  ciGreen: boolean;
  riskGate: { passed: boolean; filesTouched: number; diffLines: number; forbiddenHits: string[] };
  stopped: boolean;
  levelAtMergeTime: 0 | 1 | 2 | 3;
  decision: 'merge' | 'degrade' | 'hold';
  reason?: string;
}
