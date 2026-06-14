from dotenv import load_dotenv
import groq
load_dotenv()

import time

import os
import psycopg2
from groq import Groq

# Initialize Groq client
client = groq.Groq(api_key=os.getenv("GROQ_API_KEY"))



def insert_title_moods(conn, tmdb_id, mood_names):
    """Connect a title to its moods in the title_moods bridge table."""
    cursor = conn.cursor()

    # Find internal IDs from both tables and insert the relationship
    # We pass tmdb_id to find the title and mood name to find the mood
    insert_sql = """
        INSERT INTO title_moods (title_id, mood_id)
        SELECT titles.id, moods.id
        FROM titles, moods
        WHERE titles.tmdb_id = %s        
        AND moods.name = %s              
        ON CONFLICT (title_id, mood_id) DO NOTHING
    """

    # Loop through each mood name Claude assigned to this title
    for mood_name in mood_names:
        cursor.execute(insert_sql, (tmdb_id, mood_name))

    cursor.close()
    conn.commit()
    print(f"Tagged {len(mood_names)} moods for tmdb_id {tmdb_id}")

def fetch_all_titles(conn):
    """Fetch all titles with their genres from the database."""
    cursor = conn.cursor()

    select_sql = """
        SELECT 
            titles.tmdb_id,
            titles.title,
            titles.overview,
            titles.release_year,
            titles.vote_average,
            titles.popularity,
            -- Join all genre names into one string like "Action, Adventure, Comedy"
            STRING_AGG(genres.name, ', ') as genre_names
        FROM titles
        LEFT JOIN title_genres ON titles.id = title_genres.title_id
        LEFT JOIN genres ON title_genres.genre_id = genres.id
        WHERE titles.id NOT IN (
             SELECT DISTINCT title_id FROM title_moods
        )
        GROUP BY titles.tmdb_id, titles.title, titles.overview, 
                titles.release_year, titles.vote_average, titles.popularity
    """

    cursor.execute(select_sql)
    results = cursor.fetchall()
    cursor.close()
    return results

def get_moods_from_groq(title, overview, genre_names, release_year, vote_average, popularity, all_moods):
    """Send movie info to Groq AI and get back matching moods."""
   
    # Build the mood list as a string so AI knows exactly what to pick from
    mood_list = ", ".join(all_moods)
    
    # Determine popularity perception based on score
    # This gives AI context about how the general public sees this title
    if popularity > 200:
        popularity_context = "extremely popular and widely talked about right now"
    elif popularity > 50:
        popularity_context = "moderately popular with a decent audience"
    else:
        popularity_context = "niche or under the radar, not widely known"
    
    # Determine general reception based on rating
    if vote_average >= 8.0:
        reception = "critically acclaimed, most people who watched it loved it"
    elif vote_average >= 7.0:
        reception = "generally well received with positive audience response"
    elif vote_average >= 6.0:
        reception = "mixed reception, some love it some dont"
    else:
        reception = "low rated, divisive or generally disliked"

    # Build the full prompt with all context
    prompt = f"""Here is a movie or TV show called "{title}" released in {release_year}.

Description: {overview}

Genres: {genre_names}

General public opinion: {reception} with a rating of {vote_average}/10

Popularity: {popularity_context}

From this list of moods, pick the ones that best match the theme, 
cliche points, and overall vibe of this title. Consider the description, 
genres, how people generally feel about it, and whether it is niche or mainstream.
The goal is to help someone decide whether to watch it based on how it actually feels to watch.

Available moods:
{mood_list}

Rules:
- Only pick moods from the exact list above, spelling must match exactly
- Pick between 2 and 5 moods maximum
- Return ONLY the mood names separated by commas, nothing else
- No explanations, no extra text, just the mood names

Example response: Feel Good, Dumb Humor, Underdog Story"""

    # Send to Groq with temperature 0.4 for mostly consistent results
    response = client.chat.completions.create(  # pyright: ignore[reportUndefinedVariable]
        model="llama-3.3-70b-versatile",
        messages=[
            {
                "role": "user",
                "content": prompt
            }
        ],
        temperature=0.4
    )
    
    
    # Extract the text response
    raw_response = response.choices[0].message.content.strip()
    
    # Split into a list and clean whitespace
    mood_names = [mood.strip() for mood in raw_response.split(",")]
    
    # Filter out any moods that don't exactly match your list
    # This prevents AI from making up mood names
    valid_moods = [mood for mood in mood_names if mood in all_moods]
    
    return valid_moods

def main():
    """Loop through all titles and tag them with moods using Groq AI."""
    
    # Connect to PostgreSQL
    conn = psycopg2.connect(
        host=os.getenv("PGHOST", "localhost"),
        port=os.getenv("PGPORT", "5432"),
        user=os.getenv("PGUSER", "postgres"),
        password=os.getenv("PGPASSWORD", ""),
        dbname="streamiq"
    )

    try:
        # Step 1: Get all mood names from your database
        # These get passed to Groq so it only picks from your exact list
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM moods ORDER BY name")
        all_moods = [row[0] for row in cursor.fetchall()]
        cursor.close()
        print(f"Loaded {len(all_moods)} moods from database")

        # Step 2: Get all titles with their genres from your database
        titles = fetch_all_titles(conn)
        print(f"Found {len(titles)} titles to tag")

        # Step 3: Loop through every title and tag it with moods
        for title_row in titles:
            # Unpack the row from fetch_all_titles
            tmdb_id, title, overview, release_year, vote_average, popularity, genre_names = title_row

            # Skip titles with no overview, nothing to analyze
            if not overview:
                print(f"Skipping {title}, no overview")
                continue

            print(f"Tagging: {title}")

            # Step 4: Ask Groq to pick moods for this title
            mood_names = get_moods_from_groq(
                title=title,
                overview=overview,
                genre_names=genre_names or "Unknown",
                release_year=release_year,      # real value now
                vote_average=float(vote_average or 0),
                popularity=float(popularity or 0),
                all_moods=all_moods
            )
    
            print(f"  Got moods: {mood_names}")
            time.sleep(0.5) 
            # Step 5: Insert those moods into title_moods table
            if mood_names:
                insert_title_moods(conn, tmdb_id, mood_names)

        print("Done tagging all titles.")

    except Exception as e:
        conn.rollback()
        print(f"Error: {e}")
        raise

    finally:
        conn.close()


if __name__ == "__main__":
    main()