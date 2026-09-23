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


def calculate_overall_cgpa(semesters: list[dict]) -> dict:
    """
    Calculate overall CGPA across all semesters.
    
    Args:
        semesters: List of semester dicts, each containing 'courses' list
        
    Returns:
        Dict with overall_cgpa, total_credits, total_earned_credits, semester_gpas
    """
    grand_total_weighted = 0.0
    grand_total_credits = 0.0
    grand_total_earned = 0.0
    semester_results = []
    
    for semester in semesters:
        courses = semester.get('courses', [])
        if not courses:
            # If no courses but has gpa and credits directly
            gpa = semester.get('gpa', 0)
            credits = semester.get('credits', 0)
            if gpa and credits:
                semester_results.append({
                    "name": semester.get('name', 'Unknown'),
                    "gpa": float(gpa),
                    "credits": float(credits),
                    "courses": [],
                })
                grand_total_weighted += float(gpa) * float(credits)
                grand_total_credits += float(credits)
                if float(gpa) > 0:
                    grand_total_earned += float(credits)
            continue
        
        sem_result = calculate_semester_gpa(courses)
        
        semester_results.append({
            "name": semester.get('name', 'Unknown'),
            "gpa": sem_result["gpa"],
            "credits": sem_result["total_credits"],
            "earned_credits": sem_result["earned_credits"],
            "courses": courses,
        })
        
        grand_total_weighted += sem_result["total_weighted"]
        grand_total_credits += sem_result["total_credits"]
        grand_total_earned += sem_result["earned_credits"]
    
    overall_cgpa = grand_total_weighted / grand_total_credits if grand_total_credits > 0 else 0.0
    
    return {
        "overall_cgpa": round(overall_cgpa, 2),
        "total_credits": grand_total_credits,
        "total_earned_credits": grand_total_earned,
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
