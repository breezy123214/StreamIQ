# This loads your .env file so os.getenv() can read your secrets
# Must be the first thing that runs before any os.getenv() calls
from dotenv import load_dotenv
load_dotenv()

# Import os so we can read environment variables from the .env file
import os

# Temporary check to confirm API key is loading correctly
# Only prints first 4 characters so the real key stays secret
print("API KEY LOADED:", os.getenv("TMDB_API_KEY")[:4] if os.getenv("TMDB_API_KEY") else "NOT FOUND")

# requests lets Python make HTTP calls to external APIs like TMDB
import requests

# psycopg2 is the phone line between Python and PostgreSQL
import psycopg2

# Your TMDB API key read from .env, never hardcoded directly in code
TMDB_API_KEY = os.getenv("TMDB_API_KEY")

# The starting address for every TMDB API call
# Every endpoint gets added to the end of this
TMDB_BASE_URL = "https://api.themoviedb.org/3"

# PostgreSQL connection settings, all read from .env file
DB_HOST = os.getenv("PGHOST", "localhost")
DB_PORT = os.getenv("PGPORT", "5432")
DB_USER = os.getenv("PGUSER", "postgres")
DB_PASSWORD = os.getenv("PGPASSWORD", "")
DB_NAME = "streamiq"


def fetch_discover(endpoint, page=1):
    """Fetch titles from a TMDB discover endpoint with filters applied."""
    # Discover endpoints let us filter by language, vote count, and more
    # This gives us much more control than the basic popular or top_rated endpoints
    url = f"{TMDB_BASE_URL}/{endpoint}"
    params = {"api_key": TMDB_API_KEY, "page": page}
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json().get("results", [])


def parse_movie(item):
    """Take one raw TMDB movie dictionary and shape it into a database row."""
    # Get the release date string, default to empty string if missing
    release_date = item.get("release_date") or ""

    # Extract just the year from a date like 2021-08-27
    # The [:4] takes the first 4 characters which is always the year
    release_year = int(release_date[:4]) if len(release_date) >= 4 else None

    return (
        item["id"],
        item.get("title") or item.get("name", "Unknown"),  # handles both movie and TV naming
        "movie",
        item.get("overview"),
        release_year,
        item.get("popularity"),
        item.get("vote_average"),
        item.get("poster_path"),
    )


def parse_tv_show(item):
    """Take one raw TMDB TV show dictionary and shape it into a database row."""
    # TV shows use first_air_date instead of release_date
    first_air_date = item.get("first_air_date") or ""
    release_year = int(first_air_date[:4]) if len(first_air_date) >= 4 else None

    return (
        item["id"],
        item.get("name") or item.get("title", "Unknown"),  # TV shows use name not title
        "tv",
        item.get("overview"),
        release_year,
        item.get("popularity"),
        item.get("vote_average"),
        item.get("poster_path"),
    )


def insert_titles(conn, rows):
    """Insert all title rows into PostgreSQL using upsert logic."""
    cursor = conn.cursor()

    # ON CONFLICT DO UPDATE means if a row already exists update it
    # This keeps data fresh without creating duplicates
    insert_sql = """
        INSERT INTO titles (
            tmdb_id, title, type, overview,
            release_year, popularity, vote_average, poster_path
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (tmdb_id, type) DO UPDATE SET
            title = EXCLUDED.title,
            overview = EXCLUDED.overview,
            release_year = EXCLUDED.release_year,
            popularity = EXCLUDED.popularity,
            vote_average = EXCLUDED.vote_average,
            poster_path = EXCLUDED.poster_path
    """

    for row in rows:
        cursor.execute(insert_sql, row)

    cursor.close()


def fetch_genres():
    """Fetch the master genre list from TMDB so we can translate genre IDs to names."""
    url = f"{TMDB_BASE_URL}/genre/movie/list"
    params = {"api_key": TMDB_API_KEY}
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()["genres"]


def insert_genres(conn, genres):
    """Insert all genres into the genres table."""
    cursor = conn.cursor()

    # DO NOTHING means skip if genre already exists
    insert_sql = """
        INSERT INTO genres (tmdb_genre_id, name)
        VALUES (%s, %s)
        ON CONFLICT (tmdb_genre_id) DO NOTHING
    """

    for genre in genres:
        cursor.execute(insert_sql, (genre["id"], genre["name"]))

    cursor.close()
    conn.commit()
    print(f"Inserted {len(genres)} genres.")


def insert_title_genres(conn, title_id, genres):
    """Connect titles to their genres in the title_genres bridge table."""
    cursor = conn.cursor()

    # SELECT INSERT pattern looks up internal IDs automatically
    # Bridges TMDBs ID system and your internal ID system
    insert_sql = """
        INSERT INTO title_genres (title_id, genre_id)
        SELECT titles.id, genres.id
        FROM titles, genres
        WHERE titles.tmdb_id = %s
        AND genres.tmdb_genre_id = %s
        ON CONFLICT (title_id, genre_id) DO NOTHING
    """

    for genre_id in genres:
        cursor.execute(insert_sql, (title_id, genre_id))

    cursor.close()
    conn.commit()


def cleanup_duplicates():
    """Remove TV entries that are duplicates of movies with same tmdb_id and popularity."""
    # Open a fresh connection just for cleanup
    cleanup_conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT,
        user=DB_USER, password=DB_PASSWORD,
        dbname=DB_NAME,
    )
    try:
        cursor = cleanup_conn.cursor()

        # Must delete child records before parent to avoid foreign key errors
        # Delete genre connections for duplicate TV entries first
        cursor.execute("""
            DELETE FROM title_genres 
            WHERE title_id IN (
                SELECT t1.id FROM titles t1
                JOIN titles t2 ON t1.tmdb_id = t2.tmdb_id 
                AND t1.type = 'tv' AND t2.type = 'movie'
                AND t1.popularity = t2.popularity
            )
        """)

        # Delete mood connections for duplicate TV entries
        cursor.execute("""
            DELETE FROM title_moods
            WHERE title_id IN (
                SELECT t1.id FROM titles t1
                JOIN titles t2 ON t1.tmdb_id = t2.tmdb_id 
                AND t1.type = 'tv' AND t2.type = 'movie'
                AND t1.popularity = t2.popularity
            )
        """)

        # Now safe to delete the duplicate TV title rows
        cursor.execute("""
            DELETE FROM titles
            WHERE id IN (
                SELECT t1.id FROM titles t1
                JOIN titles t2 ON t1.tmdb_id = t2.tmdb_id 
                AND t1.type = 'tv' AND t2.type = 'movie'
                AND t1.popularity = t2.popularity
            )
        """)

        cleanup_conn.commit()
        print("Cleaned up duplicate entries.")
    finally:
        cleanup_conn.close()


def main():
    """Main pipeline: fetch from TMDB using curated discover endpoints, store in PostgreSQL."""

    # Fetch genre lookup table first
    genres = fetch_genres()

    # MOVIE ENDPOINTS
    # Using discover API for precise control over what we fetch
    # vote_count.gte filters out obscure titles with unreliable ratings
    # with_original_language filters by production language not subtitle language
    movie_endpoint_configs = [
        # English popular movies
        "discover/movie?sort_by=popularity.desc&vote_count.gte=500&with_original_language=en",

        # English all time classics
        "discover/movie?sort_by=vote_average.desc&vote_count.gte=500&with_original_language=en",

        # Recent English releases from 2020 onwards
        "discover/movie?sort_by=popularity.desc&vote_count.gte=200&with_original_language=en&primary_release_date.gte=2020-01-01",

        # Korean cinema
        "discover/movie?sort_by=popularity.desc&vote_count.gte=200&with_original_language=ko",

        # Japanese anime films
        "discover/movie?sort_by=vote_average.desc&vote_count.gte=200&with_original_language=ja",

        # French cinema
        "discover/movie?sort_by=vote_average.desc&vote_count.gte=200&with_original_language=fr",

        # Spanish language
        "discover/movie?sort_by=vote_average.desc&vote_count.gte=200&with_original_language=es",

        # Oscar winners and nominees, critically acclaimed western films
        "discover/movie?sort_by=vote_average.desc&vote_count.gte=300&with_original_language=en&with_genres=18",


        "discover/movie?sort_by=vote_average.desc&vote_count.gte=1000&with_original_language=es",

        "discover/movie?sort_by=vote_average.desc&vote_count.gte=3000",

        # Action blockbusters by revenue, catches Marvel DC and big franchises
        "discover/movie?sort_by=revenue.desc&vote_count.gte=2000&primary_release_date.gte=2010-01-01",

        # Culturally relevant movies people actively talk about, high engagement
        "discover/movie?sort_by=popularity.desc&vote_count.gte=1000&primary_release_date.gte=2015-01-01&include_adult=false",

# Cult favorites and niche beloved films
        "discover/movie?sort_by=vote_average.desc&vote_count.gte=800&popularity.lte=100&include_adult=false",

# Award winning dramas specifically
        "discover/movie?sort_by=vote_average.desc&vote_count.gte=500&with_original_language=en&primary_release_date.gte=2000-01-01",
    ]

    # TV ENDPOINTS
    tv_endpoint_configs = [
        # English TV shows, mainstream western content
        "discover/tv?sort_by=popularity.desc&vote_count.gte=500&with_original_language=en",

        # English all time great shows, high vote threshold
        # Breaking Bad, Game of Thrones, The Wire etc
        "discover/tv?sort_by=vote_average.desc&vote_count.gte=1000&with_original_language=en",

        # Recent English shows from 2020 onwards
        # Euphoria, Succession, The Last of Us etc
        "discover/tv?sort_by=popularity.desc&vote_count.gte=200&with_original_language=en&first_air_date.gte=2020-01-01",

        # Korean dramas, massive and growing western following
        # Squid Game proved Korean TV is fully mainstream now
        "discover/tv?sort_by=popularity.desc&vote_count.gte=200&with_original_language=ko",

        # Anime, enormous western audience especially younger demographics
        "discover/tv?sort_by=popularity.desc&vote_count.gte=200&with_original_language=ja",

        # Best international shows with proven global recognition
        # Only shows with 2000+ votes have genuinely crossed over
        "discover/tv?sort_by=vote_average.desc&vote_count.gte=2000",
    ]

    # Fetch movies from all curated endpoints
    all_movie_items = []
    for endpoint in movie_endpoint_configs:
        for page in range(1, 11):
            # 7 pages x 20 results x 7 endpoints = up to 980 movies before deduplication
            results = fetch_discover(endpoint, page)
            all_movie_items.extend(results)
            print(f"Fetched movie page {page} from {endpoint[:50]}, got {len(results)} results")

    # Fetch TV shows from all curated endpoints
    all_tv_items = []
    for endpoint in tv_endpoint_configs:
        for page in range(1, 8):
            # 7 pages x 20 results x 6 endpoints = up to 840 shows before deduplication
            results = fetch_discover(endpoint, page)
            all_tv_items.extend(results)
            print(f"Fetched TV page {page} from {endpoint[:50]}, got {len(results)} results")

    # Remove duplicate movies using dictionary keyed by tmdb_id
    # Same movie appears across multiple endpoints, keep only one copy
    seen_movies = {}
    for item in all_movie_items:
        seen_movies[item["id"]] = item
    all_movie_items = list(seen_movies.values())

    # Same deduplication for TV shows
    seen_tv = {}
    for item in all_tv_items:
        seen_tv[item["id"]] = item
    all_tv_items = list(seen_tv.values())

    # Convert raw dictionaries into clean tuples matching table structure
    movie_rows = [parse_movie(item) for item in all_movie_items]
    tv_rows = [parse_tv_show(item) for item in all_tv_items]
    all_rows = movie_rows + tv_rows
    all_items = all_movie_items + all_tv_items

    print(f"Total: {len(movie_rows)} unique movies and {len(tv_rows)} unique TV shows")

    # Connect to PostgreSQL
    conn = psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        dbname=DB_NAME,
    )

    try:
        # Insert titles first, they must exist before genres can reference them
        insert_titles(conn, all_rows)

        # Insert genres into the genres table
        insert_genres(conn, genres)

        # Connect each title to its genres via the bridge table
        for item in all_items:
            tmdb_id = item["id"]
            genre_ids = item.get("genre_ids", [])
            if genre_ids:
                insert_title_genres(conn, tmdb_id, genre_ids)

        conn.commit()
        print(f"Done. {len(all_rows)} titles and {len(genres)} genres inserted.")

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()

    # Clean up duplicates that crept in from overlapping endpoints
    cleanup_duplicates()


if __name__ == "__main__":
    main()