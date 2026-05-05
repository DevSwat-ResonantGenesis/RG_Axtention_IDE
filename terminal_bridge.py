import sys
import time
import os

LOG_FILE = ".terminal_bridge_log"
RESP_FILE = ".terminal_bridge_resp"

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def print_header():
    print("\033[95m" + "="*60 + "\033[0m")
    print("\033[1;36m" + " DEVSWAT INTERACTIVE BRIDGE ".center(60) + "\033[0m")
    print("\033[95m" + "="*60 + "\033[0m\n")

def main():
    if os.path.exists(LOG_FILE): os.remove(LOG_FILE)
    if os.path.exists(RESP_FILE): os.remove(RESP_FILE)
    
    clear_screen()
    print_header()
    print("\033[33mSystem: Connected. Type below to chat or run commands.\033[0m")
    print("\033[90mCommands: /search <query>, /viz <type>, /exit\033[0m\n")

    while True:
        try:
            user_input = input("\033[1;32m[YOU]:\033[0m ").strip()
        except EOFError:
            break

        if user_input.lower() in ['exit', '/exit']:
            print("\n\033[31mClosing bridge...\033[0m")
            break

        if not user_input:
            continue

        # Signal the AI
        with open(LOG_FILE, "w") as f:
            f.write(user_input)

        print("\033[1;34m[DEVSWAT]:\033[0m \033[5m...\033[0m", end="\r")
        
        # Wait for response
        start_time = time.time()
        found = False
        while time.time() - start_time < 30:
            if os.path.exists(RESP_FILE):
                with open(RESP_FILE, "r") as f:
                    response = f.read()
                os.remove(RESP_FILE)
                print(f"\033[1;34m[DEVSWAT]:\033[0m {response}\n")
                found = True
                break
            time.sleep(0.5)
        
        if not found:
            print("\033[31m[SYSTEM]: Response timeout. AI is processing a large task or is offline.\033[0m\n")

if __name__ == "__main__":
    main()
