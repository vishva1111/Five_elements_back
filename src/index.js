const express = require('express')
const cors = require('cors')
require('dotenv').config()

const projectsRouter    = require('./routes/projects')
const fundRouter        = require('./routes/fund')
const dashboardRouter   = require('./routes/dashboard')
const reportsRouter     = require('./routes/reports')
const teamRouter        = require('./routes/team')
const portfolioRouter   = require('./routes/portfolio')
const profilesRouter    = require('./routes/profiles')
const myProjectsRouter    = require('./routes/myProjects')
const certificateRouter   = require('./routes/certificate')
const submitProjectRouter = require('./routes/submitProject')
const partnerRouter       = require('./routes/partner')
const adminRouter         = require('./routes/admin')
const notificationsRouter = require('./routes/notifications')
const { requireAuth }     = require('./middleware/auth')

const app = express()
const PORT = process.env.PORT || 5000

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:4173',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(express.json())

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'Five Elements Backend API is running', version: '1.0.0' })
})

// ── Routes ────────────────────────────────────────────────────────────────────
// Public — no auth required
app.use('/api/projects',   projectsRouter)
app.use('/api/profiles',   profilesRouter)

// Protected — valid Supabase JWT required
app.use('/api/fund',         requireAuth, fundRouter)
app.use('/api/dashboard',    requireAuth, dashboardRouter)
app.use('/api/reports',      requireAuth, reportsRouter)
app.use('/api/team',         requireAuth, teamRouter)
app.use('/api/portfolio',    requireAuth, portfolioRouter)
app.use('/api/my-projects',    requireAuth, myProjectsRouter)
app.use('/api/submit-project', requireAuth, submitProjectRouter)
app.use('/api/partner',       requireAuth, partnerRouter)

// Admin — role check is done inside the router itself (requireAdmin middleware)
app.use('/api/admin',         adminRouter)

// Notifications — auth checked inside router
app.use('/api/notifications', notificationsRouter)

// Public — certificate verify link (QR codes, share links)
app.use('/api/certificate',    certificateRouter)

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
})

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Five Elements API running on http://localhost:${PORT}`)
})