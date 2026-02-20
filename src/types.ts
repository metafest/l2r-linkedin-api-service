export interface LinkedInCredentials {
  csrfToken: string;
  cookies: Record<string, string>;
  profileUrn?: string;
  vanityName?: string;
  lastUpdated?: string;
}

export interface ProfileData {
  metadata: {
    fetchedAt: string;
    profileUrn: string;
    vanityName: string;
    apiVersion: string;
  };
  basicInfo: {
    firstName: string;
    lastName: string;
    publicIdentifier: string;
    headline: string;
    summary: string | null;
    location: string | null;
    profilePicture: string | null;
    premium: boolean;
  };
  experience: any[];
  education: any[];
  skills: any[];
  projects: any[];
  certifications: any[];
  volunteeringExperiences: any[];
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export interface BrowserApiResult {
  error: boolean;
  status: number;
  statusText?: string;
  body?: string;
  data?: any;
}
