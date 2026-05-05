import os
import sys
import time
import select

# Simple bridge for interactive communication
# Uses files for communication to avoid terminal capture issues

INPUT_FILE = "bridge_input.txt"
OUTPUT_FILE = "bridge_output.txt"

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def main():
    if os.path.exists(INPUT_FILE): os.remove(INPUT_FILE)
    if os.path.exists(OUTPUT_FILE): os.remove(OUTPUT_FILE)
    
    clear_screen()
    print("\033[95m============================================================\033[0m")
    print("\033[1;36m                 DEVSWAT INTERACTIVE BRIDGE                 \033[0m")
    print("\033[95m============================================================\033[0m")
    print("\033[33mSystem: Connected. Type and press Enter.\033[0m")
    
    while True:
        # Check for AI response
        if os.path.exists(OUTPUT_FILE):
            with open(OUTPUT_FILE, "r") as f:
                content = f.read()
            if content:
                print(f"\n\033[1;34m[DEVSWAT]:\033[0m {content}")
                with open(OUTPUT_FILE, "w") as f: f.write("") # Clear
        
        # Non-blocking input check
        print("\r\033[1;32m[YOU]:\033[0m ", end="", flush=True)
        
        # Simple blocking input for this version to ensure stability
        user_input = input()
        if user_input.strip().lower() == '/exit':
            break
            
        with open(INPUT_FILE, "a") as f:
            f.write(user_input + "\n")
            
        print("\033[90m(Waiting for AI...)\033[0m")
        # Wait for AI to clear input file or respond
        while os.path.exists(INPUT_FILE) and os.path.getsize(INPUT_FILE) > 0:
            if os.path.exists(OUTPUT_FILE) and os.path.getsize(OUTPUT_FILE) > 0:
                break
            time.sleep(0.5)

if __name__ == "__main__":
    main()
