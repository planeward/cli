import type {
  CommunityChapter,
  CommunityModuleProgress,
  CommunityNamedRef,
  EmulatorEntities,
  EventRegistration,
  FixtureChannel,
  FixtureCourse,
  FixtureCourseCompletion,
  FixtureEvent,
  FixtureForm,
  FixtureMember,
  FixtureMessage,
  FormSubmission,
} from "../contract";

/** The emulator's single community. */
export const EMULATOR_COMMUNITY_ID = "community_local";
export const EMULATOR_WORKSPACE_NAME = "Local Workspace";
/** The installation's APP channel (the Experience view renders in it). */
export const APP_CHANNEL_ID = "channel_app";

/** Category sidebar order; uncategorized channels come first. */
export const CHANNEL_CATEGORY_ORDER = [
  "category_community",
  "category_apps",
  "category_staff",
] as const;

/** Defaults `serializeForm` returns for a form's `settings` (`DEFAULT_FORM_SETTINGS`). */
export const DEFAULT_FORM_SETTINGS = {
  publicLink: true,
  respondent: {
    confirmationMessage: "",
    submitButtonLabel: "",
    disableAfterSubmit: false,
  },
  crm: {
    createContact: true,
    matchByEmail: true,
    createCustomer: false,
    createOpportunity: false,
    fieldMap: { name: "name", email: "email", phone: "" },
    tags: [],
  },
  theme: {},
  css: "",
  embed: { allowedOrigins: [] },
} as const;

export type SeedApp = { name: string; slug: string };

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const MONTHLY: CommunityNamedRef = {
  id: "plan_monthly",
  name: "Monthly membership",
};
const ANNUAL: CommunityNamedRef = {
  id: "plan_annual",
  name: "Annual membership",
};
const ADMIN_ROLE: CommunityNamedRef = { id: "role_admin", name: "Admin" };

type MemberSeed = {
  name: string;
  username: string | null;
  status: FixtureMember["status"];
  plan: CommunityNamedRef | null;
  staff?: boolean;
  contact?: boolean;
  /** See `FixtureMember.contactConflict`. */
  contactConflict?: boolean;
};

const MEMBER_SEEDS: MemberSeed[] = [
  {
    name: "Maya Okafor",
    username: "maya",
    status: "ACTIVE",
    plan: ANNUAL,
    staff: true,
    contact: true,
  },
  {
    name: "Liam Chen",
    username: "liamc",
    status: "ACTIVE",
    plan: MONTHLY,
    contact: true,
  },
  {
    name: "Sofia Martínez",
    username: "sofia.m",
    status: "ACTIVE",
    plan: MONTHLY,
    contact: true,
  },
  {
    name: "Noah Patel",
    username: "noahp",
    status: "ACTIVE",
    plan: ANNUAL,
    contact: true,
  },
  {
    name: "Amara Nwosu",
    username: null,
    status: "ACTIVE",
    plan: null,
    contact: true,
  },
  {
    name: "Ethan Brooks",
    username: "ethanb",
    status: "ACTIVE",
    plan: MONTHLY,
    contact: true,
  },
  { name: "Hana Sato", username: "hana", status: "ACTIVE", plan: MONTHLY },
  {
    name: "Lucas Silva",
    username: "lucas.silva",
    status: "ACTIVE",
    plan: ANNUAL,
  },
  { name: "Priya Raman", username: "priya", status: "ACTIVE", plan: MONTHLY },
  { name: "Oliver Grant", username: "ogrant", status: "SUSPENDED", plan: null },
  { name: "Zara Ahmed", username: "zara", status: "ACTIVE", plan: MONTHLY },
  { name: "Mateo Rossi", username: null, status: "ACTIVE", plan: null },
  { name: "Chloe Dubois", username: "chloe", status: "ACTIVE", plan: MONTHLY },
  { name: "Kwame Mensah", username: "kwame", status: "REVOKED", plan: null },
  { name: "Ingrid Larsen", username: "ingrid", status: "ACTIVE", plan: ANNUAL },
  { name: "Diego Torres", username: "diegot", status: "SUSPENDED", plan: null },
  { name: "Aisha Bello", username: "aisha", status: "ACTIVE", plan: MONTHLY },
  { name: "Ben Fischer", username: null, status: "REVOKED", plan: null },
  { name: "Yuki Tanaka", username: "yuki", status: "ACTIVE", plan: MONTHLY },
  { name: "Grace Kim", username: "gracek", status: "ACTIVE", plan: MONTHLY },
  // Customer without an email and with contacts, none primary: RSVPs and
  // form submissions get 409 "Member has no primary contact.".
  {
    name: "Rafael Costa",
    username: "rafa",
    status: "ACTIVE",
    plan: MONTHLY,
    contactConflict: true,
  },
];

const pad = (n: number) => String(n).padStart(2, "0");

export const memberId = (n: number) => `member_${pad(n)}`;

function emailFor(name: string) {
  return `${name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, ".")}@example.com`;
}

function seedMembers(now: number): FixtureMember[] {
  return MEMBER_SEEDS.map((seed, index) => {
    const n = index + 1;
    return {
      id: memberId(n),
      customerId: `customer_${pad(n)}`,
      username: seed.username,
      displayName: seed.name,
      avatarUrl: null,
      status: seed.status,
      accessPlans: seed.plan ? [seed.plan] : [],
      roles: seed.staff ? [ADMIN_ROLE] : [],
      badges: [],
      joinedAt: new Date(now - (90 - index * 3) * DAY).toISOString(),
      email: emailFor(seed.name),
      contactId: seed.contact ? `contact_${pad(n)}` : null,
      contactConflict: seed.contactConflict ?? false,
    };
  });
}

function seedChannels(app: SeedApp): FixtureChannel[] {
  const open = { view: true, send: true };
  return [
    {
      id: "channel_announcements",
      name: "announcements",
      slug: "announcements",
      description: "News from the team. Members can read and react.",
      kind: "TEXT",
      categoryId: null,
      position: 0,
      everyone: { view: true, send: false },
    },
    {
      id: "channel_general",
      name: "general",
      slug: "general",
      description: "Say hi and share what you're working on.",
      kind: "TEXT",
      categoryId: "category_community",
      position: 0,
      everyone: open,
    },
    {
      id: "channel_wins",
      name: "wins",
      slug: "wins",
      description: "Celebrate progress, big and small.",
      kind: "TEXT",
      categoryId: "category_community",
      position: 1,
      everyone: open,
    },
    appChannel(app),
    {
      id: "channel_staff",
      name: "staff-lounge",
      slug: "staff-lounge",
      description:
        "Private to staff. Hidden from @everyone, so apps never see it.",
      kind: "TEXT",
      categoryId: "category_staff",
      position: 0,
      everyone: { view: false, send: false },
    },
  ];
}

/** The installation's APP channel, named after the manifest. */
export function appChannel(app: SeedApp): FixtureChannel {
  return {
    id: APP_CHANNEL_ID,
    name: app.name,
    slug: app.slug,
    description: `${app.name} (local app)`,
    kind: "APP",
    categoryId: "category_apps",
    position: 0,
    everyone: { view: true, send: true },
  };
}

function seedMessages(members: FixtureMember[], now: number): FixtureMessage[] {
  const name = (n: number) => members[n - 1]!.displayName;
  const at = (hoursAgo: number) =>
    new Date(now - hoursAgo * HOUR).toISOString();
  const memberMessage = (
    id: string,
    channelId: string,
    n: number,
    body: string,
    hoursAgo: number,
    extra: Partial<FixtureMessage> = {}
  ): FixtureMessage => ({
    id,
    channelId,
    body,
    replyToId: null,
    createdAt: at(hoursAgo),
    editedAt: null,
    author: {
      kind: "member",
      memberId: memberId(n),
      installationId: null,
      name: name(n),
    },
    reactions: [],
    deletedAt: null,
    ...extra,
  });

  return [
    {
      id: "msg_0001",
      channelId: "channel_announcements",
      body: "Welcome to the community! Monthly live Q&A is next week, RSVP in the events tab.",
      replyToId: null,
      createdAt: at(72),
      editedAt: null,
      author: {
        kind: "staff",
        memberId: null,
        installationId: null,
        name: name(1),
      },
      reactions: [
        { emoji: "🎉", memberId: memberId(2) },
        { emoji: "🎉", memberId: memberId(3) },
        { emoji: "🎉", memberId: memberId(6) },
        { emoji: "👍", memberId: memberId(4) },
      ],
      deletedAt: null,
    },
    memberMessage(
      "msg_0002",
      "channel_general",
      2,
      "Morning all! Starting the Foundations course today.",
      50,
      {
        reactions: [
          { emoji: "🔥", memberId: memberId(3) },
          { emoji: "👋", memberId: memberId(5) },
        ],
      }
    ),
    memberMessage(
      "msg_0003",
      "channel_general",
      3,
      "Welcome Liam! The weekly review module is my favourite.",
      49,
      {
        replyToId: "msg_0002",
      }
    ),
    memberMessage(
      "msg_0004",
      "channel_general",
      5,
      "Has anyone tried the reflection prompts in the evening?",
      30,
      {
        reactions: [{ emoji: "👀", memberId: memberId(9) }],
      }
    ),
    memberMessage(
      "msg_0005",
      "channel_general",
      9,
      "Yes, before bed works best for me.",
      29,
      {
        replyToId: "msg_0004",
      }
    ),
    memberMessage(
      "msg_0006",
      "channel_general",
      11,
      "Oops, wrong channel.",
      20,
      {
        deletedAt: at(19),
      }
    ),
    memberMessage(
      "msg_0007",
      "channel_general",
      6,
      "Is the Q&A recorded for people in other time zones?",
      8
    ),
    memberMessage(
      "msg_0008",
      "channel_wins",
      2,
      "Finished Foundations! Every module done.",
      26,
      {
        reactions: [
          { emoji: "🎉", memberId: memberId(1) },
          { emoji: "🎉", memberId: memberId(3) },
          { emoji: "🎉", memberId: memberId(4) },
          { emoji: "💪", memberId: memberId(13) },
        ],
      }
    ),
    memberMessage(
      "msg_0009",
      "channel_wins",
      13,
      "Kept my morning routine for 10 days straight.",
      12,
      {
        reactions: [{ emoji: "💪", memberId: memberId(2) }],
      }
    ),
    memberMessage(
      "msg_0010",
      "channel_wins",
      17,
      "Booked my first client this week!",
      3
    ),
    memberMessage(
      "msg_0011",
      "channel_staff",
      1,
      "Reminder: Oliver's membership is paused until his card is updated.",
      40,
      {
        author: {
          kind: "staff",
          memberId: null,
          installationId: null,
          name: name(1),
        },
      }
    ),
  ];
}

const chapter = (
  id: string,
  title: string,
  position: number,
  modules: Array<
    [id: string, title: string, description: string, seconds: number]
  >
): CommunityChapter => ({
  id,
  title,
  position,
  modules: modules.map(
    ([moduleId, moduleTitle, description, seconds], index) => ({
      id: moduleId,
      title: moduleTitle,
      description,
      durationSeconds: seconds,
      position: index,
    })
  ),
});

function withCounts(
  course: Omit<FixtureCourse, "chapterCount" | "moduleCount">
): FixtureCourse {
  const chapters = course.chapters.filter((item) => item.modules.length > 0);
  return {
    ...course,
    chapterCount: chapters.length,
    moduleCount: chapters.reduce((sum, item) => sum + item.modules.length, 0),
  };
}

function seedCourses(now: number): FixtureCourse[] {
  return [
    withCounts({
      id: "course_foundations",
      title: "Foundations",
      description: "Build the habits the rest of the program depends on.",
      position: 0,
      publishedAt: new Date(now - 60 * DAY).toISOString(),
      soldThroughProduct: true,
      chapters: [
        chapter("chapter_start", "Getting started", 0, [
          ["module_welcome", "Welcome", "How the program works.", 180],
          [
            "module_setup",
            "Set up your workspace",
            "Tools and a weekly calendar.",
            420,
          ],
        ]),
        chapter("chapter_habits", "Daily habits", 1, [
          [
            "module_morning",
            "Morning routine",
            "A 20-minute start to the day.",
            600,
          ],
          [
            "module_review",
            "Weekly review",
            "Close the week in 30 minutes.",
            540,
          ],
          [
            "module_reflect",
            "Reflection prompts",
            "Five questions for the evening.",
            300,
          ],
        ]),
        // No modules yet: members (and the API) don't see this chapter.
        chapter("chapter_bonus", "Bonus material", 2, []),
      ],
    }),
    withCounts({
      id: "course_advanced",
      title: "Advanced coaching",
      description: "Draft course; not published, so the API hides it.",
      position: 1,
      publishedAt: null,
      soldThroughProduct: true,
      chapters: [
        chapter("chapter_clients", "Working with clients", 0, [
          ["module_discovery", "Discovery calls", "Run a first call.", 900],
          ["module_pricing", "Pricing", "Price your offer.", 720],
        ]),
      ],
    }),
    withCounts({
      id: "course_toolkit",
      title: "Templates toolkit",
      description:
        "Published but not sold through any product, so the API hides it.",
      position: 2,
      publishedAt: new Date(now - 30 * DAY).toISOString(),
      soldThroughProduct: false,
      chapters: [
        chapter("chapter_templates", "Templates", 0, [
          ["module_planner", "Weekly planner", "A printable planner.", 240],
        ]),
      ],
    }),
  ];
}

function seedProgress(now: number): CommunityModuleProgress[] {
  const done = (
    n: number,
    moduleId: string,
    chapterId: string,
    daysAgo: number
  ): CommunityModuleProgress => ({
    memberId: memberId(n),
    moduleId,
    chapterId,
    courseId: "course_foundations",
    completedAt: new Date(now - daysAgo * DAY).toISOString(),
    videoPositionSeconds: 0,
  });
  return [
    done(2, "module_welcome", "chapter_start", 6),
    done(2, "module_setup", "chapter_start", 5),
    done(2, "module_morning", "chapter_habits", 4),
    done(2, "module_review", "chapter_habits", 3),
    done(2, "module_reflect", "chapter_habits", 1),
    done(3, "module_welcome", "chapter_start", 10),
    done(3, "module_setup", "chapter_start", 9),
    {
      memberId: memberId(3),
      moduleId: "module_morning",
      chapterId: "chapter_habits",
      courseId: "course_foundations",
      completedAt: null,
      videoPositionSeconds: 120,
    },
    done(4, "module_welcome", "chapter_start", 2),
    done(10, "module_welcome", "chapter_start", 20),
  ];
}

/** Member 2 finished Foundations (see `seedProgress`); the event already went out. */
function seedCourseCompletions(now: number): FixtureCourseCompletion[] {
  return [
    {
      memberId: memberId(2),
      courseId: "course_foundations",
      completedAt: new Date(now - DAY).toISOString(),
    },
  ];
}

const registration = (
  id: string,
  eventId: string,
  n: number,
  registeredAt: string,
  attendance: EventRegistration["attendance"] = "PENDING",
  classifiedAt: string | null = null
): EventRegistration => ({
  id,
  eventId,
  contactId: `contact_${pad(n)}`,
  registeredAt,
  confirmationSentAt: registeredAt,
  attendance,
  joinedAt: null,
  leftAt: null,
  classifiedAt,
});

function seedEvents(now: number): FixtureEvent[] {
  // Whole hours so the fixture reads like a scheduled call.
  const hour = Math.floor(now / HOUR) * HOUR;
  const qaStart = hour + 7 * DAY;
  const workshopStart = hour - 14 * DAY;
  const created = new Date(now - 21 * DAY).toISOString();
  const iso = (ms: number) => new Date(ms).toISOString();
  return [
    {
      id: "event_live_qa",
      workspaceId: "",
      name: "Monthly live Q&A",
      slug: "monthly-live-qa",
      startsAt: iso(qaStart),
      endsAt: iso(qaStart + HOUR),
      timezone: "America/New_York",
      offerStartsAt: null,
      status: "SCHEDULED",
      // A form apps can't see: they get `formId: null` and `form: null`.
      formId: "form_intake",
      showInCommunity: true,
      createdAt: created,
      updatedAt: created,
      registrations: [
        registration("registration_01", "event_live_qa", 2, iso(now - 3 * DAY)),
        registration("registration_02", "event_live_qa", 3, iso(now - 2 * DAY)),
        registration("registration_03", "event_live_qa", 5, iso(now - DAY)),
      ],
    },
    {
      id: "event_strategy_workshop",
      workspaceId: "",
      name: "Private strategy workshop",
      slug: "private-strategy-workshop",
      startsAt: iso(workshopStart),
      endsAt: iso(workshopStart + 2 * HOUR),
      timezone: "Europe/London",
      offerStartsAt: iso(workshopStart + 90 * 60 * 1000),
      status: "ENDED",
      formId: null,
      // Not flagged: apps get 404 "Event not shown in community.".
      showInCommunity: false,
      createdAt: created,
      updatedAt: created,
      registrations: [
        registration(
          "registration_04",
          "event_strategy_workshop",
          4,
          iso(workshopStart - 3 * DAY),
          "ATTENDED",
          iso(workshopStart + 3 * HOUR)
        ),
        registration(
          "registration_05",
          "event_strategy_workshop",
          6,
          iso(workshopStart - 2 * DAY),
          "NO_SHOW",
          iso(workshopStart + 3 * HOUR)
        ),
      ],
    },
  ];
}

function seedForms(now: number): FixtureForm[] {
  const created = new Date(now - 30 * DAY).toISOString();
  const checkinSubmission: FormSubmission = {
    id: "submission_01",
    formId: "form_checkin",
    source: "HOST",
    fields: { wins: "Finished Foundations.", energy: "high", share: true },
    status: "NEW",
    contactId: "contact_02",
    customerId: "customer_02",
    opportunityId: null,
    createdAt: new Date(now - DAY).toISOString(),
  };
  return [
    {
      id: "form_checkin",
      workspaceId: "",
      name: "Weekly check-in",
      slug: "weekly-check-in",
      publicSlug: "weekly-check-in",
      status: "PUBLISHED",
      description: "Two minutes to look back on your week.",
      fields: {
        sections: [
          {
            id: "page_1",
            title: "Check-in",
            description: "",
            fields: [
              {
                id: "wins",
                slug: "wins",
                type: "textarea",
                label: "Wins this week",
                required: true,
              },
              {
                id: "energy",
                slug: "energy",
                type: "radio",
                label: "Energy level",
                required: true,
                options: [
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ],
              },
              {
                id: "share",
                slug: "share",
                type: "boolean",
                label: "OK to share in the community",
              },
            ],
          },
        ],
      },
      settings: { ...DEFAULT_FORM_SETTINGS },
      showInCommunity: true,
      submissionCount: 1,
      createdAt: created,
      updatedAt: new Date(now - 2 * DAY).toISOString(),
      submissions: [checkinSubmission],
    },
    {
      id: "form_intake",
      workspaceId: "",
      name: "Coaching intake",
      slug: "coaching-intake",
      publicSlug: "coaching-intake",
      status: "PUBLISHED",
      description: "Internal intake for 1:1 clients.",
      fields: {
        sections: [
          {
            id: "page_1",
            title: "Contact",
            description: "",
            fields: [
              {
                id: "name",
                slug: "name",
                type: "string",
                label: "Name",
                required: true,
                placeholder: "Your name",
              },
              {
                id: "email",
                slug: "email",
                type: "email",
                label: "Email",
                required: true,
                placeholder: "you@example.com",
              },
              {
                id: "message",
                slug: "message",
                type: "textarea",
                label: "Message",
                placeholder: "How can we help?",
              },
            ],
          },
        ],
      },
      settings: { ...DEFAULT_FORM_SETTINGS },
      // Not flagged: apps never see this form.
      showInCommunity: false,
      submissionCount: 0,
      createdAt: created,
      updatedAt: created,
      submissions: [],
    },
  ];
}

/**
 * Deterministic seed data: the same members, channels, messages, courses,
 * events and forms every time, with timestamps relative to `now`.
 */
export function createSeedEntities(input: {
  app: SeedApp;
  workspaceId: string;
  now: Date;
}): EmulatorEntities {
  const now = input.now.getTime();
  const members = seedMembers(now);
  return {
    members,
    channels: seedChannels(input.app),
    messages: seedMessages(members, now),
    courses: seedCourses(now),
    progress: seedProgress(now),
    courseCompletions: seedCourseCompletions(now),
    events: seedEvents(now).map((event) => ({
      ...event,
      workspaceId: input.workspaceId,
    })),
    forms: seedForms(now).map((form) => ({
      ...form,
      workspaceId: input.workspaceId,
    })),
    badges: [],
  };
}
