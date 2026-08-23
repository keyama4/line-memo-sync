// Subscription data stored in LINE_SUBSCRIPTIONS KV
// voiceCount / voiceFreeLimit are absent in records written before the voice
// feature shipped; getSubscription() normalizes them on read.
export interface SubscriptionData {
  stripeCustomerId: string;
  subscriptionId: string | null;
  status: 'free' | 'active' | 'past_due' | 'canceled';
  imageCount: number;
  freeLimit: number;
  voiceCount: number;
  voiceFreeLimit: number;
  currentPeriodEnd: number | null;
  createdAt: number;
  updatedAt: number;
}

// API Response for GET /subscription/:lineUserId
export interface SubscriptionResponse {
  status: 'free' | 'active' | 'past_due' | 'canceled';
  imageCount: number;
  freeLimit: number;
  voiceCount: number;
  voiceFreeLimit: number;
  canSendImage: boolean;
  canUseVoice: boolean;
  remainingFreeImages: number | null;
  remainingFreeVoice: number | null;
}

// Stripe Checkout Session (minimal fields we need)
export interface StripeCheckoutSession {
  id: string;
  url: string;
  customer: string;
  subscription: string;
  metadata: {
    lineUserId?: string;
  };
}

// Stripe Customer Portal Session
export interface StripePortalSession {
  url: string;
}

// Stripe Webhook Event
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: StripeCheckoutSession | StripeSubscription | StripeInvoice | Record<string, unknown>;
  };
}

// Stripe Subscription object (from webhook events)
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_end: number;
}

// Stripe Invoice object (from webhook events)
export interface StripeInvoice {
  id: string;
  customer: string;
  subscription: string;
}
