import os
import time
import sys

INPUT_FILE = "bridge_input.txt"
OUTPUT_FILE = "bridge_output.txt"

def main():
    print("\n" + "="*50)
    print("      DEVSWAT TERMINAL MODE: ACTIVE")
    print("="*50)
    print("I am now listening to this terminal.")
    
    # Clear previous files
    with open(INPUT_FILE, "w") as f: f.write("")
    with open(OUTPUT_FILE, "w") as f: f.write("")

    while True:
        try:
            user_input = input("\nYou > ")
            if user_input.lower() in ["exit", "quit"]:
                print("Closing bridge...")
                break
            
            # Write user message for AI to read
            with open(INPUT_FILE, "w") as f:
                f.write(user_input)
            
            print("\n[DevSwat is thinking...]", end="\r")
            
            # Wait for AI response
            found_response = False
            while not found_response:
                if os.path.exists(OUTPUT_FILE) and os.path.getsize(OUTPUT_FILE) > 0:
                    with open(OUTPUT_FILE, "r") as f:
                        response = f.read()
                    print("\n" + "-"*50)
                    print(f"DevSwat > {response}")
                    print("-"*50)
                    # Clear output file so we don't read it again
                    with open(OUTPUT_FILE, "w") as f: f.write("")
                    found_response = True
                time.sleep(0.5)
                
        except KeyboardInterrupt:
            break

if __name__ == "__main__":
    main()
