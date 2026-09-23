"""
CGPA Calculator for DIU (Daffodil International University)
"""

# DIU Grading Scale
DIU_GRADE_POINTS = {
    "A+": 4.00,
    "A": 3.75,
    "A-": 3.50,
    "B+": 3.25,
    "B": 3.00,
    "B-": 2.75,
    "C+": 2.50,
    "C": 2.25,
    "D": 2.00,
    "F": 0.00,
    "I": None,   # Incomplete - exclude from calculation
    "W": None,   # Withdrawn - exclude from calculation
    "R": None,   # Retake marker
}


def grade_to_point(grade: str) -> float | None:
    """Convert a letter grade to grade point."""
    grade = grade.strip().upper()
    return DIU_GRADE_POINTS.get(grade)


def calculate_semester_gpa(courses: list[dict]) -> dict:
    """
    Calculate GPA for a single semester.
    
    Args:
        courses: List of course dicts with 'credits', 'grade' or 'grade_point'
        
    Returns:
        Dict with gpa, total_credits, earned_credits
    """
    total_weighted = 0.0
    total_credits = 0.0
    earned_credits = 0.0
    
    for course in courses:
        credits = float(course.get('credits', 0) or 0)
        if credits <= 0:
            continue
        
        # Get grade point
        grade_point = course.get('grade_point')
        if grade_point is None:
            grade = course.get('grade', '')
            grade_point = grade_to_point(grade)
        
        if grade_point is None:
            continue  # Skip incomplete/withdrawn courses
        
        grade_point = float(grade_point)
        total_weighted += credits * grade_point
        total_credits += credits
        
        if grade_point > 0:
            earned_credits += credits
    
    gpa = total_weighted / total_credits if total_credits > 0 else 0.0
    
    return {
        "gpa": round(gpa, 2),
        "total_credits": total_credits,
        "earned_credits": earned_credits,
        "total_weighted": total_weighted,
    }


def normalize_course_code(code: str, title: str = "") -> str:
    """Normalizes course code by removing spaces, hyphens, and converting to uppercase."""
    clean_code = (code or "").strip().replace(" ", "").replace("-", "").upper()
    if clean_code:
        return clean_code
    return (title or "").strip().lower()


def calculate_overall_cgpa(semesters: list[dict]) -> dict:
    """
    Calculate overall CGPA across all semesters with retake deduplication:
    - If a course appears more than once, only the attempt with the highest grade point is counted.
    - If grade points are identical, the latest attempt is kept.
    - Course credits are counted only once in total credits and completed credits.
    - Lower attempts are excluded from overall CGPA and credit totals.
    - Individual semester GPA and semester credits remain untouched.
    
    Args:
        semesters: List of semester dicts, each containing 'courses' list
        
    Returns:
        Dict with overall_cgpa, total_credits, total_earned_credits, semesters
    """
    semester_results = []
    course_attempts: dict[str, list[dict]] = {}
    standalone_semesters = []
    
    for sem_idx, semester in enumerate(semesters):
        courses = semester.get('courses', [])
        if not courses:
            # If no courses but has gpa and credits directly
            gpa = float(semester.get('gpa', 0.0) or 0.0)
            credits = float(semester.get('credits', 0.0) or 0.0)
            if gpa and credits:
                semester_results.append({
                    "name": semester.get('name', 'Unknown'),
                    "gpa": float(gpa),
                    "credits": float(credits),
                    "courses": [],
                })
                standalone_semesters.append((float(gpa), float(credits)))
            continue
        
        sem_result = calculate_semester_gpa(courses)
        semester_results.append({
            "name": semester.get('name', 'Unknown'),
            "gpa": sem_result["gpa"],
            "credits": sem_result["total_credits"],
            "earned_credits": sem_result["earned_credits"],
            "courses": courses,
        })
        
        for c in courses:
            code = c.get("code") or c.get("courseCode") or ""
            title = c.get("name") or c.get("courseTitle") or ""
            key = normalize_course_code(code, title)
            if not key:
                continue
                
            cr = float(c.get("credits", 0.0) or c.get("courseCredit", 0.0) or 0.0)
            gp = c.get("grade_point")
            if gp is None:
                gp = c.get("pointEquivalent")
            if gp is None:
                grade_str = c.get("grade") or c.get("gradeLetter") or ""
                gp = grade_to_point(grade_str)
            gp = float(gp or 0.0)
            gr = (c.get("grade") or c.get("gradeLetter") or "").strip().upper()
            
            # Skip incomplete/withdrawn/retake markers with no credit
            if gr in ["I", "W", "R"]:
                continue
                
            if key not in course_attempts:
                course_attempts[key] = []
                
            course_attempts[key].append({
                "sem_idx": sem_idx,
                "credits": cr,
                "grade_point": gp,
                "grade": gr,
            })

    grand_total_weighted = 0.0
    grand_total_credits = 0.0
    grand_total_earned = 0.0
    
    for key, attempts in course_attempts.items():
        # Select best attempt: highest grade_point, then latest sem_idx
        best = max(attempts, key=lambda a: (a["grade_point"], a["sem_idx"]))
        cr = best["credits"]
        gp = best["grade_point"]
        gr = best["grade"]
        
        if cr <= 0:
            continue
            
        if gr == "F":
            grand_total_credits += cr
        elif gp > 0:
            grand_total_weighted += cr * gp
            grand_total_credits += cr
            grand_total_earned += cr

    for gpa, credits in standalone_semesters:
        grand_total_weighted += gpa * credits
        grand_total_credits += credits
        if gpa > 0:
            grand_total_earned += credits

    overall_cgpa = grand_total_weighted / grand_total_credits if grand_total_credits > 0 else 0.0
    
    return {
        "overall_cgpa": round(overall_cgpa, 2),
        "total_credits": round(grand_total_credits, 2),
        "total_earned_credits": round(grand_total_earned, 2),
        "semesters": semester_results,
    }


def calculate_cgpa_from_graph(graph_data: list[dict]) -> dict:
    """
    Calculate overall CGPA from the graph API data.
    The graph API returns per-semester CGPA values.
    
    Note: This gives an APPROXIMATE overall CGPA since we don't have
    per-semester credit counts. For exact CGPA, we need course-level data.
    
    Args:
        graph_data: List of {semester, cgpa} dicts from /api/graph
        
    Returns:
        Dict with approximate CGPA info
    """
    valid_semesters = [s for s in graph_data if float(s.get('cgpa', 0)) > 0]
    
    if not valid_semesters:
        return {
            "overall_cgpa": 0.0,
            "method": "graph_average",
            "semesters_counted": 0,
            "note": "No completed semesters found",
        }
    
    # Simple average (not credit-weighted since we don't have credits)
    total_cgpa = sum(float(s['cgpa']) for s in valid_semesters)
    avg_cgpa = total_cgpa / len(valid_semesters)
    
    return {
        "overall_cgpa": round(avg_cgpa, 2),
        "method": "graph_average",
        "semesters_counted": len(valid_semesters),
        "semester_gpas": [
            {"semester": s.get('semester', ''), "cgpa": float(s.get('cgpa', 0))}
            for s in graph_data
        ],
        "note": "Approximate (simple average). For exact CGPA, need credit-weighted calculation.",
    }


# Test
if __name__ == "__main__":
    # Test with sample data
    test_courses = [
        {"name": "Programming", "credits": 3, "grade": "A+"},
        {"name": "Math", "credits": 3, "grade": "A"},
        {"name": "English", "credits": 3, "grade": "B+"},
        {"name": "Physics", "credits": 3, "grade": "A-"},
        {"name": "Lab", "credits": 1.5, "grade": "A"},
    ]
    
    result = calculate_semester_gpa(test_courses)
    print(f"Semester GPA: {result['gpa']}")
    
    # Test graph-based CGPA
    test_graph = [
        {"semester": "Fall 2023", "cgpa": 3.75},
        {"semester": "Spring 2024", "cgpa": 3.50},
        {"semester": "Summer 2024", "cgpa": 3.80},
    ]
    
    cgpa_result = calculate_cgpa_from_graph(test_graph)
    print(f"Overall CGPA (from graph): {cgpa_result['overall_cgpa']}")
    print(f"Method: {cgpa_result['method']}")
