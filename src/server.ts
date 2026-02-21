import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { LinkedInService } from './linkedin.service';
import { ApiResponse } from './types';

dotenv.config();

const PORT = process.env.PORT || 3001;
const API_TOKEN =
  process.env.API_TOKEN || 'your-secret-static-token-here-change-this';

const VALID_SECTIONS = [
  'experience',
  'education',
  'skills',
  'projects',
  'certifications',
  'volunteering-experiences',
];

// ── Service initialisation ────────────────────────────────────────────

const credentialsPath = process.env.CREDENTIALS_PATH
  ? path.resolve(process.env.CREDENTIALS_PATH)
  : path.join(process.cwd(), 'linkedin-credentials.json');

const linkedInService = new LinkedInService({
  credentialsPath,
  ambientTraffic: process.env.AMBIENT_TRAFFIC === 'true',
});

// ── Express app ───────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Request logger
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(
    `\n[${new Date().toISOString()}] ${req.method} ${req.path}`
  );
  next();
});

// ── Auth middleware ────────────────────────────────────────────────────

const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    const r: ApiResponse = {
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authorization token is required',
        details: 'Provide a Bearer token in the Authorization header',
      },
    };
    return res.status(401).json(r);
  }

  if (token !== API_TOKEN) {
    const r: ApiResponse = {
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Invalid authorization token',
      },
    };
    return res.status(403).json(r);
  }

  next();
};

// ── Health check ──────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  const usage = linkedInService.getHourlyUsage();
  res.json({
    success: true,
    data: {
      status: 'healthy',
      service: 'linkedin-api-service-2 (playwright)',
      timestamp: new Date().toISOString(),
      hourlyUsage: usage,
    },
  });
});

// ── Full profile endpoint ─────────────────────────────────────────────

app.get(
  '/api/v2/profile/:vanityName',
  authenticate,
  async (req: Request, res: Response) => {
    const vanityName = req.params.vanityName as string;

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`🎯 [V2-Playwright] Fetching full profile: ${vanityName}`);
    console.log(`${'═'.repeat(65)}\n`);

    try {
      if (!vanityName || !vanityName.trim()) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_VANITY_NAME',
            message: 'Vanity name is required',
          },
        } as ApiResponse);
      }

      const profileData = await linkedInService.fetchProfileData(vanityName);

      console.log(`\n✅ Request completed\n${'═'.repeat(65)}\n`);

      res.json({ success: true, data: profileData } as ApiResponse);
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      console.log(`${'═'.repeat(65)}\n`);
      res.status(classifyError(error)).json(buildErrorResponse(error, vanityName));
    }
  }
);

// ── Single section endpoint ───────────────────────────────────────────

app.get(
  '/api/v2/profile/:vanityName/section/:sectionType',
  authenticate,
  async (req: Request, res: Response) => {
    const vanityName = req.params.vanityName as string;
    const sectionType = req.params.sectionType as string;

    console.log(`\n${'═'.repeat(65)}`);
    console.log(
      `🎯 [V2-Playwright] Fetching [${sectionType}] for: ${vanityName}`
    );
    console.log(`${'═'.repeat(65)}\n`);

    try {
      if (!vanityName || !vanityName.trim()) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_VANITY_NAME',
            message: 'Vanity name is required',
          },
        } as ApiResponse);
      }

      if (!VALID_SECTIONS.includes(sectionType)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_SECTION_TYPE',
            message: `Invalid section type: ${sectionType}`,
            details: `Valid values: ${VALID_SECTIONS.join(', ')}`,
          },
        } as ApiResponse);
      }

      const items = await linkedInService.fetchSingleSection(
        vanityName,
        sectionType
      );

      console.log(
        `✅ Section [${sectionType}] — ${items.length} items\n${'═'.repeat(65)}\n`
      );

      res.json({
        success: true,
        data: { vanityName, sectionType, count: items.length, items },
      } as ApiResponse);
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      console.log(`${'═'.repeat(65)}\n`);
      res.status(classifyError(error)).json(buildErrorResponse(error, vanityName));
    }
  }
);

// ── 404 ───────────────────────────────────────────────────────────────

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `${req.method} ${req.path} does not exist`,
    },
  } as ApiResponse);
});

// ── Global error handler ──────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: err.message },
  } as ApiResponse);
});

// ── Error helpers ─────────────────────────────────────────────────────

function classifyError(error: any): number {
  const msg: string = error.message || '';
  if (msg.includes('Could not find profile')) return 404;
  if (msg.includes('Credentials file not found')) return 500;
  if (msg.includes('Session may be expired') || msg.includes('CSRF')) return 401;
  if (msg.includes('rate limit') || msg.includes('429')) return 429;
  return 500;
}

function buildErrorResponse(error: any, vanityName: string): ApiResponse {
  const msg: string = error.message || '';
  let code = 'INTERNAL_ERROR';

  if (msg.includes('Could not find profile')) code = 'PROFILE_NOT_FOUND';
  else if (msg.includes('Credentials file not found')) code = 'CREDENTIALS_MISSING';
  else if (msg.includes('Session may be expired') || msg.includes('CSRF')) code = 'SESSION_EXPIRED';
  else if (msg.includes('rate limit') || msg.includes('429')) code = 'RATE_LIMITED';

  return {
    success: false,
    error: {
      code,
      message: error.message,
      details: `Request for profile: ${vanityName}`,
    },
  };
}

// ── Startup ───────────────────────────────────────────────────────────

async function start() {
  console.log('\n' + '═'.repeat(65));
  console.log('🚀 LinkedIn API Service v2 (Playwright-based)');
  console.log('═'.repeat(65));
  console.log(`\n📁 Credentials: ${credentialsPath}`);
  console.log(`🌐 Ambient traffic: ${process.env.AMBIENT_TRAFFIC === 'true' ? 'ON' : 'OFF'}`);
  console.log(`👁  Headless: ${process.env.HEADLESS !== 'false' ? 'YES' : 'NO (headed)'}\n`);

  console.log('Initializing browser session...\n');
  try {
    await linkedInService.init();
  } catch (err: any) {
    console.warn(
      '⚠ Browser/session init failed (server will start anyway):',
      err.message
    );
    console.warn('   Mount valid linkedin-credentials.json to enable scraping.\n');
  }

  app.listen(PORT, () => {
    console.log('\n' + '═'.repeat(65));
    console.log(`📍 Server running on: http://localhost:${PORT}`);
    console.log(`🔐 API Token: ${API_TOKEN}`);
    console.log(`\n📚 Endpoints:`);
    console.log(`   GET  /health`);
    console.log(`   GET  /api/v2/profile/:vanityName`);
    console.log(
      `   GET  /api/v2/profile/:vanityName/section/:sectionType`
    );
    console.log(
      `\n   Sections: ${VALID_SECTIONS.join(', ')}`
    );
    console.log(`\n📖 Example:`);
    console.log(
      `   curl -H "Authorization: Bearer ${API_TOKEN}" \\`
    );
    console.log(`        http://localhost:${PORT}/api/v2/profile/nikiljos`);
    console.log('\n' + '═'.repeat(65) + '\n');
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await linkedInService.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await linkedInService.shutdown();
  process.exit(0);
});

start().catch((err) => {
  console.error('❌ Failed to start service:', err.message);
  process.exit(1);
});

export default app;
