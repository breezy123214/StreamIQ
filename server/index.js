// Load environment variables from .env file first
require('dotenv').config()

const express = require('express')
const path = require('path')
const { Pool } = require('pg')
const cors = require('cors')

const app = express()



// Rate limiting prevents someone from hammering your API
const rateLimit = require('express-rate-limit')

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100                   // max 100 requests per 15 minutes per IP
})

app.use(limiter)

// Restrict CORS to only your frontend
app.use(cors({
    origin: ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3000']
}))

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, '..', 'public')))

const pool = new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE
})

// Mood name -> UI category (vibe, humor, story, experience)
const MOOD_CATEGORY_MAP = {
    'Feel Good': 'vibe', 'Chill': 'vibe', 'Cozy': 'vibe', 'Uplifting': 'vibe',
    'Nostalgic': 'vibe', 'Dreamy': 'vibe', 'Romantic': 'vibe', 'Whimsical': 'vibe',
    'Dark': 'vibe', 'Gritty': 'vibe', 'Bleak': 'vibe', 'Atmospheric': 'vibe',
    'Dumb Humor': 'humor', 'Witty': 'humor', 'Dark Comedy': 'humor',
    'Satirical': 'humor', 'Absurd': 'humor', 'Dry Humor': 'humor', 'Silly': 'humor',
    'Underdog Story': 'story', 'Coming of Age': 'story', 'Revenge': 'story',
    'Heist': 'story', 'Mystery': 'story', 'Twisty': 'story', 'Epic': 'story',
    'Character Study': 'story', 'Slow Burn': 'story', 'Biographical': 'story',
    'Edge of Seat': 'experience', 'Adrenaline': 'experience', 'Intense': 'experience',
    'Mind Bending': 'experience', 'Thought Provoking': 'experience', 'Emotional': 'experience',
    'Cry Fest': 'experience', 'Scary': 'experience', 'Suspenseful': 'experience',
    'Escapist': 'experience', 'Inspiring': 'experience', 'Epic Scale': 'experience',
    'Edge of Your Seat': 'experience', 'Nostalgia': 'vibe', 'Comfort Watch': 'vibe'
}

function inferMoodCategory(name) {
    if (MOOD_CATEGORY_MAP[name]) return MOOD_CATEGORY_MAP[name]
    const n = name.toLowerCase()
    if (/humor|funny|laugh|dumb|witty|comedy|satir/i.test(n)) return 'humor'
    if (/story|arc|plot|underdog|burn|twist|revenge|heist|mystery|epic|romance|triangle/i.test(n)) return 'story'
    if (/feel|vibe|nostalg|cozy|chill|good|comfort|dream|whims|romantic|hype/i.test(n)) return 'vibe'
    return 'experience'
}

const MOODS_SUBQUERY = `
    COALESCE(
    (SELECT json_agg(m.name) FROM (
        SELECT DISTINCT moods.name 
        FROM title_moods 
        JOIN moods ON title_moods.mood_id = moods.id
        WHERE title_moods.title_id = titles.id
        LIMIT 4
    ) m), '[]'
) as moods
`

const GENRES_SUBQUERY = `
    COALESCE(
        (SELECT json_agg(g.name ORDER BY g.name)
         FROM title_genres tg
         JOIN genres g ON tg.genre_id = g.id
         WHERE tg.title_id = titles.id),
        '[]'::json
    ) AS genres
`

function titleSelect(extraWhere = '', params = [], typeFilter = null) {
    const conditions = []
    const values = [...params]
    if (typeFilter) {
        values.push(typeFilter)
        conditions.push(`titles.type = $${values.length}`)
    }
    if (extraWhere) conditions.push(extraWhere)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    return {
        sql: `
            SELECT titles.tmdb_id, titles.title, titles.type, titles.overview,
                   titles.release_year, titles.popularity, titles.vote_average,
                   titles.poster_path, ${MOODS_SUBQUERY}
            FROM titles
            ${where}
            ORDER BY titles.popularity DESC
        `,
        values
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})

const TITLE_GROUP = `
    GROUP BY titles.tmdb_id, titles.title, titles.type,
             titles.overview, titles.release_year,
             titles.popularity, titles.vote_average, titles.poster_path
`

const TITLE_SELECT = `
    titles.tmdb_id, titles.title, titles.type,
    titles.overview, titles.release_year,
    titles.popularity, titles.vote_average, titles.poster_path,
    COALESCE(json_agg(DISTINCT moods.name)
    FILTER (WHERE moods.name IS NOT NULL), '[]') AS moods
`

function getPagination(req) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 20))
    return { page, limit, offset: (page - 1) * limit }
}

async function fetchPaginatedTitles(type, genre, page, limit, offset) {
    const values = [type]
    const joins = [
        'LEFT JOIN title_moods ON titles.id = title_moods.title_id',
        'LEFT JOIN moods ON title_moods.mood_id = moods.id'
    ]
    const conditions = [`titles.type = $1`, `titles.popularity > 13`, `titles.vote_average > 4`]

    if (genre) {
        values.push(genre)
        joins.push('JOIN title_genres ON titles.id = title_genres.title_id')
        joins.push('JOIN genres ON title_genres.genre_id = genres.id')
        conditions.push(`genres.name = $${values.length}`)
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const joinSql = joins.join('\n            ')

    const countResult = await pool.query(`
        SELECT COUNT(DISTINCT titles.tmdb_id)::int AS total
        FROM titles
        ${genre ? 'JOIN title_genres ON titles.id = title_genres.title_id JOIN genres ON title_genres.genre_id = genres.id' : ''}
        ${where}
    `, values)

    const total = countResult.rows[0].total
    values.push(limit, offset)

    const itemsResult = await pool.query(`
        SELECT ${TITLE_SELECT}
        FROM titles
        ${joinSql}
        ${where}
        ${TITLE_GROUP}
        ORDER BY titles.popularity DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values)

    return {
        items: itemsResult.rows,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
    }
}

async function fetchAllTitles(type, genre = null) {
    const values = [type]
    const joins = [
        'LEFT JOIN title_moods ON titles.id = title_moods.title_id',
        'LEFT JOIN moods ON title_moods.mood_id = moods.id'
    ]
    const conditions = [`titles.type = $1`, `titles.popularity > 13`, `titles.vote_average > 4`]

    if (genre) {
        values.push(genre)
        joins.push('JOIN title_genres ON titles.id = title_genres.title_id')
        joins.push('JOIN genres ON title_genres.genre_id = genres.id')
        conditions.push(`genres.name = $${values.length}`)
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const joinSql = joins.join('\n            ')

    const result = await pool.query(`
        SELECT ${TITLE_SELECT}
        FROM titles
        ${joinSql}
        ${where}
        ${TITLE_GROUP}
        ORDER BY titles.popularity DESC
    `, values)

    return result.rows
}

app.get('/api/movies', async (req, res) => {
    try {
        res.json(await fetchAllTitles('movie'))
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/shows', async (req, res) => {
    try {
        res.json(await fetchAllTitles('tv'))
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/moods', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT name, description FROM moods ORDER BY name ASC
        `)
        const rows = result.rows.map((row) => ({
            ...row,
            category: inferMoodCategory(row.name)
        }))
        res.json(rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/titles/mood/:name', async (req, res) => {
    try {
        const { name } = req.params
        const result = await pool.query(`
            SELECT 
                titles.tmdb_id, titles.title, titles.type,
                titles.overview, titles.release_year,
                titles.popularity, titles.vote_average, titles.poster_path,
                COALESCE(json_agg(DISTINCT moods.name) 
                FILTER (WHERE moods.name IS NOT NULL), '[]') as moods
            FROM titles
            LEFT JOIN title_moods ON titles.id = title_moods.title_id
            LEFT JOIN moods ON title_moods.mood_id = moods.id
            WHERE titles.id IN (
                SELECT title_moods.title_id
                FROM title_moods
                JOIN moods ON title_moods.mood_id = moods.id
                WHERE moods.name = $1
            )
            GROUP BY titles.tmdb_id, titles.title, titles.type,
                     titles.overview, titles.release_year,
                     titles.popularity, titles.vote_average, titles.poster_path
            ORDER BY titles.popularity DESC
            LIMIT 100
        `, [name])
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

function parseMoodList(query) {
    const raw = query.mood ?? query.moods
    if (!raw) return []
    const list = Array.isArray(raw) ? raw : [raw]
    return [...new Set(list.flatMap((item) => String(item).split(',').map((s) => s.trim()).filter(Boolean)))]
}

app.get('/api/titles/filter', async (req, res) => {
    try {
        const moods = parseMoodList(req.query)
        const { genre, type } = req.query
        const values = []
        const conditions = []
        let joinSql = ''

        if (moods.length) {
            values.push(moods)
            const matchAny = req.query.match === 'any'
            conditions.push(matchAny
                ? `
                titles.id IN (
                    SELECT tm.title_id
                    FROM title_moods tm
                    JOIN moods m ON tm.mood_id = m.id
                    WHERE m.name = ANY($${values.length}::text[])
                )
            `
                : `
                titles.id IN (
                    SELECT tm.title_id
                    FROM title_moods tm
                    JOIN moods m ON tm.mood_id = m.id
                    WHERE m.name = ANY($${values.length}::text[])
                    GROUP BY tm.title_id
                    HAVING COUNT(DISTINCT m.name) = ${moods.length}
                )
            `)
        }
        if (genre) {
            values.push(genre)
            joinSql += `
            JOIN title_genres ON titles.id = title_genres.title_id
            JOIN genres ON title_genres.genre_id = genres.id`
            conditions.push(`genres.name = $${values.length}`)
        }
        if (type === 'movie' || type === 'tv') {
            values.push(type)
            conditions.push(`titles.type = $${values.length}`)
        }

        const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

        const result = await pool.query(`
            SELECT titles.tmdb_id, titles.title, titles.type, titles.overview,
                           titles.release_year, titles.popularity, titles.vote_average,
                           titles.poster_path, ${MOODS_SUBQUERY}
                    FROM titles
                    ${joinSql}
                    ${whereSql}
                   GROUP BY titles.id, titles.tmdb_id, titles.title, titles.type, titles.overview,
                    titles.release_year, titles.popularity, titles.vote_average,
                    titles.poster_path
                    ORDER BY titles.popularity DESC
                `, values)
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/movieoftheday', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                titles.tmdb_id, titles.title, titles.type,
                titles.overview, titles.release_year,
                titles.popularity, titles.vote_average, titles.poster_path,
                COALESCE(json_agg(DISTINCT moods.name) 
                FILTER (WHERE moods.name IS NOT NULL), '[]') as moods
            FROM titles
            LEFT JOIN title_moods ON titles.id = title_moods.title_id
            LEFT JOIN moods ON title_moods.mood_id = moods.id
            WHERE titles.type = 'movie'
            GROUP BY titles.tmdb_id, titles.title, titles.type,
                     titles.overview, titles.release_year,
                     titles.popularity, titles.vote_average, titles.poster_path
            ORDER BY MOD(titles.tmdb_id, EXTRACT(DOY FROM CURRENT_DATE)::INTEGER + 1)
            LIMIT 1
        `)
        res.json(result.rows[0])
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

// Named routes must come before /api/titles/:tmdb_id
app.get('/api/titles/new', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ${TITLE_SELECT}
            FROM titles
            LEFT JOIN title_moods ON titles.id = title_moods.title_id
            LEFT JOIN moods ON title_moods.mood_id = moods.id
            WHERE titles.release_year IS NOT NULL
            ${TITLE_GROUP}
            ORDER BY titles.release_year DESC, titles.popularity DESC
            LIMIT 50
        `)
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/titles/classics', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ${TITLE_SELECT}
            FROM titles
            LEFT JOIN title_moods ON titles.id = title_moods.title_id
            LEFT JOIN moods ON title_moods.mood_id = moods.id
            WHERE titles.release_year < 2010 AND titles.vote_average >= 7.5
            ${TITLE_GROUP}
            ORDER BY titles.vote_average DESC
            LIMIT 50
        `)
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/titles/staffpicks', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ${TITLE_SELECT}
            FROM titles
            LEFT JOIN title_moods ON titles.id = title_moods.title_id
            LEFT JOIN moods ON title_moods.mood_id = moods.id
            WHERE titles.vote_average >= 7.5
              AND titles.popularity BETWEEN 20 AND 150
            ${TITLE_GROUP}
            ORDER BY titles.vote_average DESC
            LIMIT 50
        `)
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/titles/:tmdb_id', async (req, res) => {
    try {
        const { tmdb_id } = req.params
        if (!/^\d+$/.test(tmdb_id)) {
            return res.status(404).json({ error: 'Title not found' })
        }
        const result = await pool.query(`
            SELECT titles.tmdb_id, titles.title, titles.type, titles.overview,
                   titles.release_year, titles.popularity, titles.vote_average,
                   titles.poster_path, ${MOODS_SUBQUERY}, ${GENRES_SUBQUERY}
            FROM titles
            WHERE titles.tmdb_id = $1
        `, [tmdb_id])
        if (!result.rows[0]) {
            return res.status(404).json({ error: 'Title not found' })
        }
        res.json(result.rows[0])
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/genres', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM genres ORDER BY name ASC`)
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/movies/genre/:name', async (req, res) => {
    try {
        const { name } = req.params
        res.json(await fetchAllTitles('movie', name))
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/shows/genre/:name', async (req, res) => {
    try {
        const { name } = req.params
        res.json(await fetchAllTitles('tv', name))
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/classics', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT titles.tmdb_id, titles.title, titles.type, titles.overview,
                   titles.release_year, titles.popularity, titles.vote_average,
                   titles.poster_path, ${MOODS_SUBQUERY}
            FROM titles
            WHERE release_year < 2000 AND vote_average >= 7.5
            ORDER BY vote_average DESC
            LIMIT 20
        `)
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/whatsnew', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT titles.tmdb_id, titles.title, titles.type, titles.overview,
                   titles.release_year, titles.popularity, titles.vote_average,
                   titles.poster_path, ${MOODS_SUBQUERY}
            FROM titles
            WHERE release_year IS NOT NULL
            ORDER BY release_year DESC, popularity DESC
            LIMIT 20
        `)
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/staffpicks', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT titles.tmdb_id, titles.title, titles.type, titles.overview,
                   titles.release_year, titles.popularity, titles.vote_average,
                   titles.poster_path, ${MOODS_SUBQUERY}
            FROM titles
            WHERE vote_average >= 7.5
              AND popularity >= 35
              AND popularity <= 220
            ORDER BY vote_average DESC, popularity ASC
            LIMIT 20
        `)
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/hiddengems', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT titles.tmdb_id, titles.title, titles.type, titles.overview,
                   titles.release_year, titles.popularity, titles.vote_average,
                   titles.poster_path, ${MOODS_SUBQUERY}
            FROM titles
            WHERE vote_average >= 7.5 AND popularity < 100
            ORDER BY vote_average DESC
            LIMIT 20
        `)
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

app.get('/api/similar/:tmdb_id', async (req, res) => {
    try {
        const { tmdb_id } = req.params
        const result = await pool.query(`
            SELECT 
                titles.tmdb_id, titles.title, titles.type,
                titles.overview, titles.release_year,
                titles.popularity, titles.vote_average, titles.poster_path,
                COUNT(genres.id) as shared_genres,
                COALESCE(json_agg(DISTINCT moods.name) 
                FILTER (WHERE moods.name IS NOT NULL), '[]') as moods
            FROM titles
            JOIN title_genres ON titles.id = title_genres.title_id
            JOIN genres ON title_genres.genre_id = genres.id
            LEFT JOIN title_moods ON titles.id = title_moods.title_id
            LEFT JOIN moods ON title_moods.mood_id = moods.id
            WHERE genres.id IN (
                SELECT genre_id FROM title_genres
                JOIN titles ON title_genres.title_id = titles.id
                WHERE titles.tmdb_id = $1
            )
            AND titles.tmdb_id != $1
            GROUP BY titles.tmdb_id, titles.title, titles.type,
                     titles.overview, titles.release_year,
                     titles.popularity, titles.vote_average, titles.poster_path
            HAVING COUNT(DISTINCT genres.id) >= 2
            ORDER BY shared_genres DESC
            LIMIT 10
        `, [tmdb_id])
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})

// GET /api/search?q=batman
// Searches titles by name across movies and TV shows
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query
        if (!q || !String(q).trim()) return res.json([])

        const term = `%${String(q).trim()}%`

        const result = await pool.query(`
            SELECT 
                titles.tmdb_id, titles.title, titles.type,
                titles.overview, titles.release_year,
                titles.popularity, titles.vote_average, titles.poster_path,
                COALESCE(json_agg(DISTINCT moods.name) 
                FILTER (WHERE moods.name IS NOT NULL), '[]') as moods
            FROM titles
            LEFT JOIN title_moods ON titles.id = title_moods.title_id
            LEFT JOIN moods ON title_moods.mood_id = moods.id
            WHERE LOWER(titles.title) LIKE LOWER($1)
            GROUP BY titles.tmdb_id, titles.title, titles.type,
                     titles.overview, titles.release_year,
                     titles.popularity, titles.vote_average, titles.poster_path
            ORDER BY titles.popularity DESC
            LIMIT 50
        `, [term])
        res.json(result.rows)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Something went wrong' })
    }
})


const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`StreamIQ server running on http://localhost:${PORT}`)
})
